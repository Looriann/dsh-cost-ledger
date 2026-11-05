#!/usr/bin/env node
/**
 * Dependency-free test runner (no vitest install needed for M1).
 *
 *   node test/run.mjs
 *
 * Covers the two places where a cost ledger can silently lie:
 *   1. route -> price resolution (identity, tiers, inherited prices)
 *   2. money math (micro-CNY, no float drift, null never becomes 0)
 * plus the ingest idempotency rule and a real session log round trip.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listSessionFiles, readSessionEvents } from "../lib/backfill.js";
import { sampleFromEvent } from "../lib/ingest.js";
import { Ledger, dayKeyOf, dayKeysBack } from "../lib/ledger.js";
import { findRow, formatCny, normalizeModelId, priceSample, ratesFor } from "../lib/pricing.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ok   " + name);
  } catch (err) {
    console.error("  FAIL " + name);
    console.error("       " + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}

console.log("\n[1] 模型身份归一");
test("去掉 vendor 前缀、日期后缀、构建号", () => {
  assert.equal(normalizeModelId("vanchin/deepseek-v4-pro-0813"), "deepseek-v4-pro");
  assert.equal(normalizeModelId("deepseek-v4.1-flash-1017"), "deepseek-v4-1-flash");
  assert.equal(normalizeModelId("qwen3.8-max-0902"), "qwen3-8-max");
  assert.equal(normalizeModelId("qwen3.8-max"), "qwen3-8-max");
  assert.equal(normalizeModelId("Kimi/Kimi-K3.1-Pro"), "kimi-k3-1-pro");
});
test("同一个模型的两种写法归一后相等", () => {
  assert.equal(normalizeModelId("deepseek-v4.1-flash"), normalizeModelId("deepseek-v4.1-flash-1017"));
});

console.log("\n[2] 价格行解析");
const book = {
  v: 1,
  rows: [
    { provider: "bailian", model: "deepseek-v4.1-flash", buckets: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }, source: "manual", confidence: "exact" },
    { provider: "openrouter", model: "deepseek-v4.1-flash", buckets: { input: 2, output: 8 }, source: "aggregator", confidence: "aggregator" }
  ]
};
test("精确命中 provider+model", () => {
  const found = findRow(book, "bailian", "deepseek-v4.1-flash");
  assert.equal(found.how, "exact");
  assert.equal(found.row.provider, "bailian");
});
test("带构建号的 id 走归一匹配", () => {
  const found = findRow(book, "bailian", "deepseek-v4.1-flash-1017");
  assert.equal(found.how, "normalized");
  assert.equal(found.row.provider, "bailian");
});
test("provider 不同 => 降级为 inherited", () => {
  const found = findRow(book, "bailian", "deepseek-v4.1-flash");
  assert.equal(found.row.provider, "bailian");
  const other = findRow(book, "siliconflow", "deepseek-v4.1-flash");
  assert.equal(other.how, "inherited");
  assert.equal(other.row.provider, "bailian");
});
test("查不到就返回 null，绝不给默认价", () => {
  assert.equal(findRow(book, "bailian", "cmaas-glm-5.3"), null);
});

console.log("\n[3] 阶梯计价");
const tiered = {
  tiers: [
    { maxPrompt: 1000000, input: 12, output: 36 },
    { maxPrompt: 32000, input: 4, output: 12 }
  ]
};
test("按输入长度选档（整档计费）", () => {
  assert.deepEqual(ratesFor(tiered, 1000), { input: 4, cacheRead: null, cacheWrite: null, output: 12 });
  assert.deepEqual(ratesFor(tiered, 40000), { input: 12, cacheRead: null, cacheWrite: null, output: 36 });
  assert.deepEqual(ratesFor(tiered, 2000000), { input: 12, cacheRead: null, cacheWrite: null, output: 36 });
});
test("无阶梯时用 buckets", () => {
  assert.equal(ratesFor({ buckets: { input: 1, output: 4 } }, 999).input, 1);
});

console.log("\n[4] 金额（微元，整数）");
test("真实样本：2392/8960/675 @ 1,0.02,4 => 5271 微元", () => {
  const sample = { pr: "bailian", m: "deepseek-v4.1-flash", i: 2392, cr: 8960, cw: 0, o: 675 };
  const priced = priceSample(book, sample);
  assert.equal(priced.micro, 5271); // 2392*1 + 8960*0.02 + 675*4 = 5271.2
  assert.equal(priced.confidence, "exact");
});
test("缓存价缺失时按输入价保守计", () => {
  const noCache = { v: 1, rows: [{ provider: "bailian", model: "x", buckets: { input: 1, output: 4 } }] };
  const priced = priceSample(noCache, { pr: "bailian", m: "x", i: 0, cr: 1000, cw: 0, o: 0 });
  assert.equal(priced.micro, 1000);
});
test("缺价 => null，不是 0", () => {
  const priced = priceSample(book, { pr: "bailian", m: "cmaas-glm-5.3", i: 10, cr: 0, cw: 0, o: 10 });
  assert.equal(priced.micro, null);
  assert.equal(priced.confidence, "unpriced");
});
test("小额显示保留 4 位有效数字", () => {
  assert.equal(formatCny(5271), "¥0.0053");
  assert.equal(formatCny(null), "—");
});

console.log("\n[5] 事件 -> 样本 与幂等");
const event = {
  type: "assistant/message",
  time: Date.now(),
  data: {
    turn: 3,
    step: 1,
    message: { source: { provider: "bailian", model: "deepseek-v4.1-flash-1017" } },
    usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1050 }
  }
};
test("解析出 provider/model/四个分项", () => {
  const sample = sampleFromEvent("s1", event);
  assert.equal(sample.k, "s1:3:1");
  assert.equal(sample.pr, "bailian");
  assert.equal(sample.m, "deepseek-v4.1-flash-1017");
  assert.equal(sample.i + sample.cr + sample.o, 1050);
});
test("非 usage 事件返回 null", () => {
  assert.equal(sampleFromEvent("s1", { type: "turn/start", data: {} }), null);
});

const dir = mkdtempSync(join(tmpdir(), "clg-test-"));
try {
  const ledger = new Ledger({ dir, log: () => {} });
  ledger.load();
  ledger.setPrice({ provider: "bailian", model: "deepseek-v4.1-flash-1017", buckets: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 } });
  ledger.ingest("s1", event);
  test("同一步骤重复上报只算一次（替换而非累加）", () => {
    const before = ledger.samples.size;
    ledger.ingest("s1", event);
    assert.equal(ledger.samples.size, before);
    const repriced = { ...event, data: { ...event.data, usage: { inputTokens: 200, cacheReadTokens: 900, outputTokens: 50 } } };
    ledger.ingest("s1", repriced);
    assert.equal(ledger.samples.size, before);
    assert.equal(ledger.samples.get("s1:3:1").i, 200);
  });

  const summary = ledger.summary({ days: 7 });
  test("汇总把金额按天归到 Asia/Shanghai 日历日", () => {
    const day = dayKeyOf(event.time);
    const slot = summary.days.find((d) => d.day === day);
    assert.ok(slot, "缺少当天数据");
    assert.equal(slot.tokens.total, 1150);
    // 200*1 + 900*0.02 + 50*4 = 418
    assert.equal(slot.micro, 418);
  });
  test("KPI 同步", () => {
    assert.equal(summaryKpiWindow(summary), 418);
  });
  test("未定价模型被单独列出", () => {
    ledger.ingest("s2", {
      type: "assistant/message",
      time: Date.now(),
      data: { turn: 1, step: 0, message: { source: { provider: "bailian", model: "cmaas-glm-5.3" } }, usage: { inputTokens: 10, outputTokens: 10 } }
    });
    const index = ledger.modelIndex();
    assert.equal(index.filter((m) => !m.priced).length, 1);
  });
  test("改价后历史数字自动更新（读时计价）", () => {
    ledger.setPrice({ provider: "bailian", model: "deepseek-v4.1-flash-1017", buckets: { input: 10, cacheRead: 0.02, cacheWrite: 1, output: 40 } });
    const again = ledger.summary({ days: 7 });
    const day = dayKeyOf(event.time);
    const slot = again.days.find((d) => d.day === day);
    assert.equal(slot.micro, 200 * 10 + 900 * 0.02 + 50 * 40);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function summaryKpiWindow(summary) {
  return summary.kpi.windowMicro;
}

console.log("\n[6] 日期窗口");
test("最近 7 天 = 7 个升序键，最后一个是今天", () => {
  const keys = dayKeysBack(7, 1762248000000);
  assert.equal(keys.length, 7);
  assert.equal(keys[0] < keys[6], true);
  assert.equal(keys[6], dayKeyOf(1762248000000));
});

console.log("\n[7] 真实日志回放");
const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const files = listSessionFiles(home);
if (files.length === 0) {
  console.log("  skip 本机没有会话日志");
} else {
  const file = files[0];
  const events = readSessionEvents(file);
  test("多帧 zstd 能完整解压（不是只解第一帧）", () => {
    assert.ok(events.length > 1, "只解出 " + events.length + " 条事件，多帧切分可能失效");
  });
  test("能从真实日志里抓到 usage 样本", () => {
    let total = 0;
    let scanned = 0;
    for (const candidate of files.slice(0, 20)) {
      scanned += 1;
      const parsed = readSessionEvents(candidate).map((e) => sampleFromEvent("real", e)).filter(Boolean);
      total += parsed.length;
      if (total > 0) {
        for (const sample of parsed) assert.ok(sample.i + sample.cr + sample.o > 0);
        break;
      }
    }
    assert.ok(total > 0, "扫描 " + scanned + " 个日志都没解析出 usage 样本");
  });
}

console.log("\n" + (process.exitCode ? "有用例失败" : "全部通过") + "（" + passed + " 项）\n");