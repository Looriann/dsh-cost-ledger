/**
 * Pricing: resolve a `(provider, model, time)` route to per-bucket CNY rates,
 * then turn tokens into money.
 *
 * Design rules (see DESIGN.md §4.3):
 *   1. The price book is keyed by `(provider, model)` — the SAME model sold by
 *      two providers has two prices, so the provider field is never guessed
 *      from the model name.
 *   2. Lookup degrades in a fixed order and every hit records HOW it matched,
 *      so the UI can show a confidence badge instead of a fake precise number.
 *   3. No match, no rates, or incomplete rates => `micro: null`. Never 0.
 *
 * Money is integer micro-CNY (1e-6 CNY). Because rates are CNY per 1,000,000
 * tokens, `tokens * rate` lands exactly in micro-CNY: no division, no drift.
 *
 * @module dsh-cost-ledger/pricing
 */

/** Confidence vocabulary, weakest last. */
export const CONF = {
  EXACT: "exact",
  OFFICIAL: "official",
  AGGREGATOR: "aggregator",
  INHERITED: "inherited",
  ESTIMATED: "estimated",
  UNPRICED: "unpriced"
};

/** Order used to pick the WORST confidence of a group. */
const CONF_RANK = {
  exact: 0,
  official: 1,
  aggregator: 2,
  inherited: 3,
  estimated: 4,
  unpriced: 5
};

/** The worse of two confidence labels. */
export function worstConfidence(a, b) {
  return (CONF_RANK[a] ?? 5) >= (CONF_RANK[b] ?? 5) ? a : b;
}

/**
 * Normalise a model id for loose matching: drop the `vendor/` prefix, fold
 * separators, drop a date suffix and a 3-4 digit build suffix.
 * `vanchin/deepseek-v4-pro-0813` -> `deepseek-v4-pro`
 * `qwen3.8-max-0902`              -> `qwen3-8-max`
 */
export function normalizeModelId(id) {
  let s = String(id || "").trim().toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/[-_.:@+\s]+/g, "-").replace(/^-+|-+$/g, "");
  s = s.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  s = s.replace(/-\d{3,4}$/, "");
  return s;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Flatten a tier entry into the four buckets we bill. */
function bucketsOf(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    input: num(entry.input),
    cacheRead: num(entry.cacheRead),
    cacheWrite: num(entry.cacheWrite),
    output: num(entry.output)
  };
}

/**
 * Rates that apply to one request, choosing a tier by prompt size when the
 * model is tiered (`0 < Token <= 32K` style).
 * Tiers are billed wholesale: the request's ENTIRE token count uses the tier
 * the prompt falls into (Bailian's documented rule), so we only pick, never
 * split.
 */
export function ratesFor(row, promptTokenCount) {
  if (!row || typeof row !== "object") return null;
  const tiers = Array.isArray(row.tiers) ? row.tiers.filter(Boolean) : [];
  if (tiers.length > 0) {
    const sorted = [...tiers].sort((a, b) => {
      const am = a.maxPrompt == null ? Infinity : a.maxPrompt;
      const bm = b.maxPrompt == null ? Infinity : b.maxPrompt;
      return am - bm;
    });
    let chosen = sorted[sorted.length - 1];
    for (const tier of sorted) {
      const max = tier.maxPrompt == null ? Infinity : tier.maxPrompt;
      if (promptTokenCount <= max) {
        chosen = tier;
        break;
      }
    }
    return bucketsOf(chosen);
  }
  return bucketsOf(row.buckets);
}

/**
 * Find the price row for a route.
 * @returns {null | {row:any, how:'exact'|'normalized'|'inherited'|'inherited-normalized'}}
 */
export function findRow(book, provider, model) {
  const rows = Array.isArray(book && book.rows) ? book.rows : [];
  const p = String(provider || "").trim().toLowerCase();
  const m = String(model || "").trim().toLowerCase();
  if (m === "") return null;
  const normalized = normalizeModelId(model);

  const sameProvider = rows.filter((r) => String(r.provider || "").toLowerCase() === p);
  const exact = sameProvider.find((r) => String(r.model || "").toLowerCase() === m);
  if (exact) return { row: exact, how: "exact" };

  const sameShape = sameProvider.find((r) => normalizeModelId(r.model) === normalized);
  if (sameShape) return { row: sameShape, how: "normalized" };

  const anywhere = rows.find((r) => String(r.model || "").toLowerCase() === m);
  if (anywhere) return { row: anywhere, how: "inherited" };

  const anywhereShape = rows.find((r) => normalizeModelId(r.model) === normalized);
  if (anywhereShape) return { row: anywhereShape, how: "inherited-normalized" };

  return null;
}

/**
 * Price one sample.
 * @param {any} book the price book
 * @param {{pr:string,m:string,i:number,cr:number,cw:number,o:number}} sample
 * @param {(now:number)=>number} [fxOf] unused in M1, reserved for USD books
 * @returns {{micro:number|null, confidence:string, how?:string, row?:any, missing?:string}}
 */
export function priceSample(book, sample) {
  const found = findRow(book, sample.pr, sample.m);
  if (!found) return { micro: null, confidence: CONF.UNPRICED, missing: "no-price-row" };

  const promptCount = sample.i + sample.cr + sample.cw;
  const rates = ratesFor(found.row, promptCount);
  if (!rates) return { micro: null, confidence: CONF.UNPRICED, missing: "no-rates", row: found.row };

  // Cache buckets are optional: when a provider has no cache price we fall back
  // to the standard input rate (conservative: never under-reports).
  const input = rates.input;
  const output = rates.output;
  if (input == null || output == null) {
    return { micro: null, confidence: CONF.UNPRICED, missing: "incomplete-rates", row: found.row };
  }
  const cacheRead = rates.cacheRead == null ? input : rates.cacheRead;
  const cacheWrite = rates.cacheWrite == null ? input : rates.cacheWrite;

  const micro = Math.round(
    sample.i * input + sample.cr * cacheRead + sample.cw * cacheWrite + sample.o * output
  );

  let confidence = found.row.confidence || (found.row.source === "manual" ? CONF.EXACT : CONF.OFFICIAL);
  if (found.how.startsWith("inherited")) confidence = CONF.INHERITED;

  return { micro, confidence, how: found.how, row: found.row };
}

/** Format micro-CNY for humans, keeping sub-cent values readable. */
export function formatCny(micro) {
  if (micro == null) return "—";
  const yuan = micro / 1e6;
  if (yuan === 0) return "¥0";
  if (Math.abs(yuan) < 0.01) return "¥" + yuan.toFixed(4);
  if (Math.abs(yuan) < 1) return "¥" + yuan.toFixed(3);
  return "¥" + yuan.toFixed(2);
}

/** Format a token count (12.3K / 1.2M). */
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 1 : 2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e5 ? 0 : 1) + "K";
  return String(v);
}