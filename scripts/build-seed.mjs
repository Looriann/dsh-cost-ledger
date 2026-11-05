#!/usr/bin/env node
/**
 * 从抓取结果生成随包发布的种子价目表。
 *
 *   node scripts/build-seed.mjs
 *
 * 输入：data/prices.auto.json（scripts/fetch-prices.mjs 的干跑产物）
 * 输出：data/prices.seed.json（首次运行时被复制到 ~/.dsh/cost-ledger/prices.json）
 *
 * 为什么要这一步：新用户装上插件时账本里一条价格都没有，界面全是「未定价」。
 * 把官方能抓到的价目随包带一份，用千问 / 百炼上的 DeepSeek / Kimi / GLM
 * 的人就能立刻看到正确金额；抓不到的（私有部署）仍然留空，由用户手填。
 *
 * 缓存单价：官方价目页只列输入/输出单价，但公开文档写明上下文缓存
 * 「命中按标准输入单价 10%、显式创建按 125%」计费。这里按该规则推算并
 * 在 note 里写明，因为绝大多数 agent 调用的 token 都落在缓存读上，
 * 若按输入价全额计会系统性高估一倍左右。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const autoFile = join(ROOT, "data", "prices.auto.json");
const seedFile = join(ROOT, "data", "prices.seed.json");

const CACHE_READ_RATIO = 0.1;
const CACHE_WRITE_RATIO = 1.25;
const round4 = (value) => Math.round(value * 10000) / 10000;

if (!existsSync(autoFile)) {
  console.error("找不到 " + autoFile);
  console.error("先跑：node scripts/fetch-prices.mjs");
  process.exit(1);
}

const auto = JSON.parse(readFileSync(autoFile, "utf8"));
const rows = [];
let cacheFilled = 0;

for (const row of auto.rows || []) {
  if (!row.model || !row.provider) continue;
  if (String(row.currency || "").toUpperCase() !== "CNY") continue;

  const buckets = row.buckets && row.buckets.input != null && row.buckets.output != null ? row.buckets : null;
  const tiers = Array.isArray(row.tiers) ? row.tiers.filter((t) => t && t.input != null && t.output != null) : [];
  if (!buckets && tiers.length === 0) continue;

  let nextBuckets = null;
  let nextTiers = null;

  if (buckets) {
    const cacheRead = buckets.cacheRead ?? round4(buckets.input * CACHE_READ_RATIO);
    const cacheWrite = buckets.cacheWrite ?? round4(buckets.input * CACHE_WRITE_RATIO);
    if (buckets.cacheRead == null || buckets.cacheWrite == null) cacheFilled += 1;
    nextBuckets = { input: buckets.input, cacheRead, cacheWrite, output: buckets.output };
  } else {
    nextTiers = tiers.map((tier) => {
      if (tier.cacheRead == null || tier.cacheWrite == null) cacheFilled += 1;
      return {
        maxPrompt: tier.maxPrompt ?? null,
        input: tier.input,
        cacheRead: tier.cacheRead ?? round4(tier.input * CACHE_READ_RATIO),
        cacheWrite: tier.cacheWrite ?? round4(tier.input * CACHE_WRITE_RATIO),
        output: tier.output
      };
    });
  }

  rows.push({
    provider: row.provider,
    model: row.model,
    currency: "CNY",
    unit: "1M",
    buckets: nextBuckets,
    tiers: nextTiers,
    source: row.source || "official",
    sourceUrl: row.sourceUrl || auto.meta?.sourceUrl || null,
    fetchedAt: row.fetchedAt || auto.meta?.fetchedAt || null,
    verifiedAt: null,
    confidence: row.confidence || "official",
    note: row.note || "阿里云百炼官方价目页",
    cacheRule: "bailian:read0.1,write1.25"
  });
}

rows.sort((a, b) => a.model.localeCompare(b.model));

const seed = {
  v: 1,
  meta: {
    updatedAt: Date.now(),
    sourceUrl: auto.meta?.sourceUrl || null,
    fetchedAt: auto.meta?.fetchedAt || null,
    note: "随包种子价目表：阿里云百炼官方公开价（人民币 / 每百万 token），含百炼上架的 DeepSeek / Kimi / GLM / MiniMax 等第三方模型。缓存单价按百炼公开规则推算（命中 10%、显式创建 125%）。私有部署不在公开价目里，装上后请自行补价。"
  },
  rows
};

writeFileSync(seedFile, JSON.stringify(seed, null, 2) + "\n");
console.log("已写入 " + seedFile + "：" + rows.length + " 条价格");
const tiered = rows.filter((r) => r.tiers).length;
console.log("  固定价 " + (rows.length - tiered) + " 条，阶梯价 " + tiered + " 条");
console.log("  其中 " + cacheFilled + " 条缓存单价按 10% / 125% 规则推算");