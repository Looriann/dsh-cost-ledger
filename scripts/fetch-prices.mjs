#!/usr/bin/env node
/**
 * Best-effort price catalogue fetcher for Aliyun Bailian.
 *
 * The console page (bailian.console.aliyun.com/model/market) is a login-gated
 * SPA: a plain fetch returns `<title>…</title> Loading…` and no prices. The
 * PUBLIC docs, however, expose a Markdown export of the same table:
 *
 *   https://help.aliyun.com/zh/model-studio/model-pricing.md
 *
 * That page carries CNY list prices, tiered bands, and free quotas for the
 * Qwen families. Third-party models (deepseek / kimi / glm) are NOT on it, and
 * private deployments (`cmaas-*`, `vanchin/*`) are not in any public catalogue
 * at all — those stay unpriced on purpose and the UI asks you to fill them in.
 *
 *   node scripts/fetch-prices.mjs            # dry run: print what matched
 *   node scripts/fetch-prices.mjs --write    # merge into ~/.dsh/cost-ledger/prices.json
 *   node scripts/fetch-prices.mjs --force    # also overwrite rows you filled by hand
 *
 * Merging never touches a row whose `source` is "manual" unless --force.
 */

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic, ensureDir } from "../lib/store.js";

const SOURCE_URL = "https://help.aliyun.com/zh/model-studio/model-pricing.md";
const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const FORCE = args.includes("--force");

const home = process.env.DSH_HOME || join(homedir(), ".dsh");
const dataDir = join(home, "cost-ledger");
const bookFile = join(dataDir, "prices.json");

/**
 * Strip HTML/JSX tags but keep text.
 *
 * The source escapes comparison signs as `\<` and uses JSX attributes
 * (`<td style={{ verticalAlign: "top" }}>`), so a naive `<[^>]*>` swallows
 * `0\<Token≤1M` all the way to the next real tag — which silently turned every
 * pricing tier into "no tier". Only well-formed tags from a known name list are
 * stripped here.
 */
const TAG_RE =
  /<\/?(?:table|thead|tbody|tr|td|th|p|br|div|span|strong|b|em|i|code|pre|a|ul|ol|li|img|colgroup|col|sup|sub|blockquote|h[1-6]|tabs|tab|note|card|cardgroup|accordion)\b[^>]*>/gi;

function textOf(html) {
  return String(html == null ? "" : html)
    .replace(/\\</g, "<")
    .replace(/\\>/g, ">")
    .replace(TAG_RE, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\\/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "12元" -> 12 ; "$0.3" -> null (we only take CNY) ; "免费" -> 0 */
function cnyOf(cell) {
  const text = textOf(cell);
  if (/免费/.test(text)) return 0;
  const match = /([0-9]+(?:\.[0-9]+)?)\s*(?:元|￥|¥)/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** "0<Token≤1M" -> 1000000 ; "无阶梯计价" -> null */
function tierMaxOf(cell) {
  const text = textOf(cell).replace(/\s/g, "");
  if (text === "" || /无阶梯/.test(text)) return null;
  const match = /≤\s*([0-9.]+)\s*([KM])?/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = (match[2] || "").toUpperCase();
  if (unit === "M") return value * 1000000;
  if (unit === "K") return value * 1000;
  return value;
}

/** Parse every <table> into rows of cell HTML, remembering the nearest heading. */
function parseTables(markdown) {
  const tables = [];
  const headingRe = /^(#{2,4})\s+(.+)$/gm;
  const headings = [];
  let headingMatch;
  while ((headingMatch = headingRe.exec(markdown)) !== null) {
    headings.push({ at: headingMatch.index, text: textOf(headingMatch[2]) });
  }
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRe.exec(markdown)) !== null) {
    const before = headings.filter((heading) => heading.at < tableMatch.index).pop();
    const rows = [];
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    let rowMatch;
    while ((rowMatch = rowRe.exec(tableMatch[0])) !== null) {
      const cells = [];
      const cellRe = /<t[dh][\s\S]*?<\/t[dh]>/gi;
      let cellMatch;
      while ((cellMatch = cellRe.exec(rowMatch[0])) !== null) cells.push(cellMatch[0]);
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push({ heading: before ? before.text : "", rows });
  }
  return tables;
}

function headerIndex(headerCells) {
  const names = headerCells.map((cell) => textOf(cell));
  const find = (needle) => names.findIndex((name) => name.includes(needle));
  return {
    model: find("模型"),
    tier: find("输入Token数"),
    input: find("输入单价"),
    output: find("输出单价"),
    quota: find("免费额度")
  };
}

function regionOf(heading) {
  const text = String(heading || "");
  if (/北京/.test(text)) return "华北2（北京）";
  if (/中国内地/.test(text)) return "中国内地";
  if (/全球/.test(text)) return "全球";
  if (/新加坡|香港|法兰克福|弗吉尼亚|东京/.test(text)) return text;
  return "";
}

/** A region's precedence when the same model is listed in several regions. */
function regionRank(region) {
  if (/北京/.test(region)) return 3;
  if (/中国内地/.test(region)) return 2;
  if (/全球/.test(region)) return 1;
  return 0;
}

function parsePricing(markdown) {
  /** @type {{model:string, region:string, tiers:any[]}[]} */
  const entries = [];
  for (const table of parseTables(markdown)) {
    const header = table.rows[0];
    if (!header) continue;
    const cols = headerIndex(header);
    if (cols.input < 0 || cols.output < 0 || cols.model < 0) continue;

    let currentModel = "";
    const byModel = new Map();
    for (const row of table.rows.slice(1)) {
      const modelCell = textOf(row[cols.model] || "");
      const input = cnyOf(row[cols.input] || "");
      const output = cnyOf(row[cols.output] || "");

      // A model cell without a price on the same row = the rowspan head of a
      // tier ladder; remember it and let the next rows extend the ladder.
      if (input == null && modelCell !== "" && /^[A-Za-z]/.test(modelCell)) {
        currentModel = modelCell.split(/[\s>]/)[0];
        continue;
      }
      if (input == null || output == null) continue;
      if (modelCell !== "" && /^[A-Za-z]/.test(modelCell)) {
        currentModel = modelCell.split(/[\s>]/)[0];
      }
      if (currentModel === "") continue;

      const max = cols.tier >= 0 ? tierMaxOf(row[cols.tier] || "") : null;
      const list = byModel.get(currentModel) || [];
      if (!list.some((tier) => tier.maxPrompt === max && tier.input === input && tier.output === output)) {
        list.push({ maxPrompt: max, input, output });
      }
      byModel.set(currentModel, list);
    }
    for (const [model, tiers] of byModel) entries.push({ model, region: regionOf(table.heading), tiers });
  }

  // One row per model: prefer 华北2（北京）(the region this machine calls), then
  // 中国内地, then 全球, then whatever came first. Regions differ in price, so
  // merging them would produce a nonsense ladder.
  const chosen = new Map();
  for (const entry of entries) {
    const previous = chosen.get(entry.model);
    if (!previous || regionRank(entry.region) > regionRank(previous.region)) chosen.set(entry.model, entry);
  }
  return [...chosen.values()];
}

async function main() {
  process.stdout.write("抓取 " + SOURCE_URL + " … ");
  const res = await fetch(SOURCE_URL, { headers: { "user-agent": "dsh-cost-ledger/0.1" } });
  if (!res.ok) {
    console.log("失败 HTTP " + res.status);
    process.exit(1);
  }
  const markdown = await res.text();
  console.log("ok " + markdown.length + " 字符");

  const parsed = parsePricing(markdown);
  const fetchedAt = Date.now();
  const rows = [];
  for (const entry of parsed) {
    const tiers = entry.tiers.filter((tier) => tier.input != null && tier.output != null);
    if (tiers.length === 0) continue;
    const flat = tiers.length === 1 && tiers[0].maxPrompt == null;
    rows.push({
      provider: "bailian",
      model: entry.model,
      currency: "CNY",
      unit: "1M",
      buckets: flat ? { input: tiers[0].input, cacheRead: null, cacheWrite: null, output: tiers[0].output } : null,
      tiers: flat ? null : tiers,
      source: "official",
      sourceUrl: SOURCE_URL,
      fetchedAt,
      verifiedAt: null,
      confidence: "official",
      note: "阿里云百炼官方价目页" + (entry.region ? " · " + entry.region : "")
    });
  }

  console.log("解析到 " + rows.length + " 个模型的 CNY 价目");
  for (const row of rows.slice(0, 8)) {
    const rates = row.buckets ? "input " + row.buckets.input + " / output " + row.buckets.output : row.tiers.map((t) => "≤" + (t.maxPrompt ?? "∞") + ":" + t.input + "/" + t.output).join(" ");
    console.log("  " + row.model.padEnd(34) + rates);
  }
  if (rows.length > 8) console.log("  … 另有 " + (rows.length - 8) + " 个");

  if (!WRITE) {
    console.log("\n（干跑：结果写到包内 data/prices.auto.json；加 --write 才合并进 " + bookFile + "）");
    const packageData = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
    ensureDir(packageData);
    writeFileSync(join(packageData, "prices.auto.json"), JSON.stringify({ v: 1, meta: { sourceUrl: SOURCE_URL, fetchedAt }, rows }, null, 2) + "\n");
    return;
  }

  const book = readJson(bookFile, { v: 1, meta: {}, rows: [] });
  const manualKeys = new Set(
    book.rows.filter((row) => row.source === "manual").map((row) => (row.provider + "/" + row.model).toLowerCase())
  );
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const key = (row.provider + "/" + row.model).toLowerCase();
    const index = book.rows.findIndex((existing) => (existing.provider + "/" + existing.model).toLowerCase() === key);
    if (index >= 0) {
      if (manualKeys.has(key) && !FORCE) {
        skipped += 1;
        continue;
      }
      book.rows[index] = row;
      updated += 1;
    } else {
      book.rows.push(row);
      added += 1;
    }
  }
  book.meta = { ...(book.meta || {}), updatedAt: Date.now(), lastSync: { at: Date.now(), sourceUrl: SOURCE_URL, added, updated, skipped } };
  writeJsonAtomic(bookFile, book);
  console.log("\n已写入 " + bookFile + "：新增 " + added + "，更新 " + updated + "，跳过手填 " + skipped);
  console.log("提示：第三方模型与私有部署不在官方页里，请在「费用」标签页里手动补价。");
}

main().catch((err) => {
  console.error("抓取失败：" + (err && err.stack ? err.stack : String(err)));
  process.exit(1);
});