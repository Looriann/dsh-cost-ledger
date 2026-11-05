#!/usr/bin/env node
/**
 * Offline replay: price a real session log with the SAME modules the plugin
 * runs, so any number in the UI can be checked against a number you can read
 * in a terminal.
 *
 *   node scripts/replay.mjs                              # every session, daily table
 *   node scripts/replay.mjs <file.jsonl.zstd>            # one session, per turn
 *   node scripts/replay.mjs --days 30
 *   node scripts/replay.mjs --sessions <dir> --data-dir <dir>
 *
 * `--sessions` / `--data-dir` exist so the whole thing can be exercised on a
 * throwaway ledger without touching ~/.dsh/cost-ledger.
 *
 * Exit codes: 0 ok, 1 bad usage / no data.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listSessionFiles, readSessionEvents, sessionIdOf } from "../lib/backfill.js";
import { Ledger } from "../lib/ledger.js";
import { formatCny, formatTokens } from "../lib/pricing.js";

const args = process.argv.slice(2);
const opts = { days: 30, file: null, dataDir: null, sessions: null };
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--days") opts.days = Number(args[(i += 1)]) || 30;
  else if (arg === "--data-dir") opts.dataDir = args[(i += 1)];
  else if (arg === "--sessions") opts.sessions = args[(i += 1)];
  else if (!arg.startsWith("--")) opts.file = arg;
}

const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const sessionsRoot = opts.sessions || join(home, "sessions");
const dataDir = opts.dataDir || join(home, "cost-ledger");

const ledger = new Ledger({ dir: dataDir, log: () => {} });
ledger.load();

function ingestFile(file) {
  const sessionId = sessionIdOf(file);
  const events = readSessionEvents(file);
  let added = 0;
  for (const event of events) if (ledger.ingest(sessionId, event)) added += 1;
  return { events: events.length, added };
}

if (opts.file) {
  if (!existsSync(opts.file)) {
    console.error("找不到文件：" + opts.file);
    process.exit(1);
  }
  const { events, added } = ingestFile(opts.file);
  const detail = ledger.sessionDetail(sessionIdOf(opts.file));
  console.log("\n会话 " + sessionIdOf(opts.file));
  console.log("事件 " + events + " 条，新增样本 " + added + " 条\n");
  console.log("轮次     tokens        成本        模型");
  console.log("------  -----------  ----------  ------------------------------------");
  for (const turn of detail.turns) {
    const models = turn.models.map((m) => m.provider + "/" + m.model).join(", ");
    const cost = turn.micro === 0 && turn.unpricedTokens > 0 ? null : turn.micro;
    console.log(
      String(turn.turn).padStart(6) +
        "  " +
        formatTokens(turn.tokens.total).padStart(11) +
        "  " +
        formatCny(cost).padStart(10) +
        "  " +
        models
    );
  }
  const total = detail.turns.reduce((sum, t) => sum + t.micro, 0);
  const unpriced = detail.turns.reduce((sum, t) => sum + t.unpricedTokens, 0);
  const tokens = detail.turns.reduce((sum, t) => sum + t.tokens.total, 0);
  const anyPriced = detail.turns.some((t) => t.micro > 0);
  console.log("------  -----------  ----------  ------------------------------------");
  console.log("合计    " + formatTokens(tokens).padStart(11) + "  " + formatCny(anyPriced ? total : null).padStart(10));
  if (unpriced > 0) console.log("（其中 " + formatTokens(unpriced) + " tokens 未定价，成本未计入）");
  process.exit(0);
}

const files = listSessionFiles(home, sessionsRoot);
if (files.length === 0) {
  console.error("在 " + sessionsRoot + " 下没有找到会话日志");
  process.exit(1);
}
let events = 0;
let added = 0;
for (const file of files) {
  const r = ingestFile(file);
  events += r.events;
  added += r.added;
}

const summary = ledger.summary({ days: opts.days });
const stats = ledger.stats();
console.log("\n扫描 " + files.length + " 个日志，" + events + " 条事件，新增样本 " + added + " 条");
console.log("样本总数 " + stats.samples + "，会话 " + stats.sessions + "，模型 " + stats.models + " 个（未定价 " + stats.unpricedModels + " 个）\n");
console.log("日期          tokens        成本     缓存命中");
console.log("----------  -----------  ----------  --------");
for (const day of summary.days) {
  const prompt = day.tokens.input + day.tokens.cacheRead + day.tokens.cacheWrite;
  const hit = prompt > 0 ? day.tokens.cacheRead / prompt : 0;
  const cost = day.micro === 0 && day.unpricedTokens > 0 ? null : day.micro;
  console.log(
    day.day.padEnd(12) +
      formatTokens(day.tokens.total).padStart(11) +
      "  " +
      formatCny(cost).padStart(10) +
      "  " +
      (hit * 100).toFixed(1).padStart(6) +
      "%"
  );
}
console.log("----------  -----------  ----------  --------");
console.log("今日 " + formatCny(summary.kpi.todayMicro) + "   近" + opts.days + "天 " + formatCny(summary.kpi.windowMicro) + "   本月 " + formatCny(summary.kpi.monthMicro));

const unpriced = ledger.modelIndex().filter((m) => !m.priced);
if (unpriced.length > 0) {
  console.log("\n未定价模型（在「费用」标签页补价后自动重算）：");
  for (const model of unpriced) {
    console.log("  - " + model.provider + "/" + model.model + "  " + formatTokens(model.tokens) + " tokens");
  }
}
console.log("");