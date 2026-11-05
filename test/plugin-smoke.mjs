#!/usr/bin/env node
/**
 * Host-half smoke test: run the plugin's `apply()` against a fake Cordis
 * context (no harness needed) and drive the HTTP routes end to end.
 *
 *   node test/plugin-smoke.mjs
 *
 * This is the test that catches the boring-but-fatal stuff: a bad import, a
 * route path typo, a handler that never responds, JSON that does not serialize,
 * and — most importantly — whether the shipped price book can actually price
 * models served by a NON-DeepSeek provider.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const { apply } = await import("../lib/index.js");

const dir = mkdtempSync(join(tmpdir(), "clg-smoke-"));
const routes = new Map();
const handlers = [];
const logLines = [];

const ctx = {
  logger: (line) => logLines.push(String(line)),
  effect: (fn) => {
    const disposer = fn();
    return typeof disposer === "function" ? disposer : () => {};
  },
  on: (event, callback) => {
    handlers.push({ event, callback });
    return () => {};
  },
  webServer: {
    register: (route) => {
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    }
  }
};

/** Minimal req/res pair for a route handler. */
function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const res = {
      headersSent: false,
      status: 0,
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
      },
      end(text) {
        try {
          resolve({ status: this.status, json: JSON.parse(text) });
        } catch (err) {
          reject(err);
        }
      }
    };
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = url;
    req.socket = { remoteAddress: "127.0.0.1" };
    const handler = routes.get(url.split("?")[0]);
    if (!handler) {
      reject(new Error("没有注册的路由：" + url));
      return;
    }
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

function emit(sessionId, event) {
  const sub = handlers.find((h) => h.event === "session/event");
  if (!sub) throw new Error("没有订阅 session/event");
  sub.callback({ id: sessionId }, event);
}

function usageEvent(model, provider, inputTokens, cacheReadTokens, outputTokens) {
  return {
    type: "assistant/message",
    time: Date.now(),
    data: {
      turn: 1,
      step: 0,
      message: { source: { provider, model } },
      usage: { inputTokens, cacheReadTokens, outputTokens }
    }
  };
}

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log("  ok   " + name);
  } catch (err) {
    failures += 1;
    console.error("  FAIL " + name);
    console.error("       " + (err && err.message ? err.message : err));
  }
}

console.log("\n[插件冒烟] 假 ctx 下加载 Host 半边");

try {
  const api = apply(ctx, { dataDir: dir, backfillOnStart: false });

  await step("apply() 返回 ledger，且每条路径只注册一次", () => {
    assert.ok(api && api.ledger, "apply 没有返回 ledger");
    assert.equal(routes.size, 7, "实际注册 " + routes.size + " 条路径：" + [...routes.keys()].join(", "));
    const paths = [...routes.keys()].map((p) => p.replace("/api/cost-ledger", "")).sort();
    assert.deepEqual(paths, ["/backfill", "/day", "/health", "/models", "/prices", "/session", "/summary"]);
  });

  await step("订阅了 session/event", () => {
    assert.ok(
      handlers.some((h) => h.event === "session/event"),
      "没有订阅 session/event"
    );
  });

  await step("随包价目表已就位（新用户装上就有价，不用先手填）", () => {
    const rows = api.ledger.prices().rows;
    assert.ok(rows.length >= 100, "种子价目表只有 " + rows.length + " 条");
  });

  await step("空账本的 /summary 正常返回", async () => {
    const res = await call("GET", "/api/cost-ledger/summary?days=7");
    assert.equal(res.status, 200);
    assert.equal(res.json.days.length, 7);
    assert.equal(res.json.kpi.samples, 0);
  });

  await step("公共价目查不到的模型 => 未定价，金额是 null 不是 0", async () => {
    emit("smoke-unpriced", usageEvent("cmaas-glm-5.3", "bailian", 1000, 9000, 500));
    const res = await call("GET", "/api/cost-ledger/summary?days=7");
    const tokens = res.json.days.reduce((sum, d) => sum + d.tokens.total, 0);
    assert.equal(tokens, 10500);
    const model = res.json.models.find((m) => m.model === "cmaas-glm-5.3");
    assert.equal(model.confidence, "unpriced");
    assert.equal(model.micro, 0);
  });

  await step("PUT /prices 补价后立刻有金额，置信度变手填", async () => {
    const put = await call("PUT", "/api/cost-ledger/prices", {
      provider: "bailian",
      model: "cmaas-glm-5.3",
      buckets: { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }
    });
    assert.equal(put.status, 200);
    const res = await call("GET", "/api/cost-ledger/summary?days=7");
    const model = res.json.models.find((m) => m.model === "cmaas-glm-5.3");
    assert.equal(model.confidence, "exact");
    assert.equal(model.micro, 3180); // 1000*1 + 9000*0.02 + 500*4
  });

  await step("非 DeepSeek 服务商的模型也能直接定价（百炼通道的 DeepSeek）", async () => {
    emit("smoke-bailian", usageEvent("deepseek-v4.1-flash-1017", "bailian", 1000, 9000, 500));
    const res = await call("GET", "/api/cost-ledger/summary?days=7");
    const model = res.json.models.find((m) => m.model === "deepseek-v4.1-flash-1017");
    assert.ok(model, "没有统计到这个模型");
    assert.equal(model.confidence, "official");
    // 官方价目：输入 2 元 / 输出 8 元每百万；缓存读按 10% 规则 = 0.2
    assert.equal(model.micro, 1000 * 2 + 9000 * 0.2 + 500 * 8);
  });

  await step("/health 报告自检数字", async () => {
    const res = await call("GET", "/api/cost-ledger/health");
    assert.equal(res.json.stats.samples, 2);
    assert.equal(res.json.stats.sessions, 2);
    assert.ok(res.json.stats.dir.includes("clg-smoke-"));
  });

  await step("非回环来源被拒绝", async () => {
    const handler = routes.get("/api/cost-ledger/health");
    const res = {
      headersSent: false,
      writeHead(status) {
        this.status = status;
        this.headersSent = true;
      },
      end(text) {
        this.body = JSON.parse(text);
      }
    };
    const req = Readable.from([]);
    req.method = "GET";
    req.url = "/api/cost-ledger/health";
    req.socket = { remoteAddress: "10.0.0.7" };
    await handler(req, res);
    assert.equal(res.status, 403);
  });

  await step("错误方法返回 405", async () => {
    const res = await call("POST", "/api/cost-ledger/summary");
    assert.equal(res.status, 405);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n冒烟通过\n" : "\n冒烟失败 " + failures + " 项\n");
process.exit(failures === 0 ? 0 : 1);