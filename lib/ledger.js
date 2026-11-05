/**
 * The ledger: samples in, daily/model rollups out.
 *
 * Invariants:
 *   - One sample per `(session, turn, step)`. A later event with the same key
 *     REPLACES the earlier one (the harness can re-emit a step), it never adds.
 *   - Money is computed at READ time, not at ingest time, so fixing a price
 *     retroactively fixes history. `samples.ndjson` is the only durable
 *     artifact; every number in the UI is derived from it.
 *   - Days are Asia/Shanghai (UTC+8) calendar days, computed without Intl so
 *     the result is identical on every host and in tests.
 *
 * @module dsh-cost-ledger/ledger
 */

import { join } from "node:path";
import { appendLine, ensureDir, readJson, readLines, writeJsonAtomic } from "./store.js";
import { sampleFromEvent, sampleTokens } from "./ingest.js";
import { CONF, priceSample, worstConfidence } from "./pricing.js";

const BOOK_FILE = "prices.json";
const SAMPLES_FILE = "samples.ndjson";

const EMPTY_BOOK = {
  v: 1,
  meta: { updatedAt: 0, source: "manual" },
  rows: []
};

/** Calendar day of an instant, in Asia/Shanghai. */
export function dayKeyOf(ts) {
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  if (!Number.isFinite(d.getTime())) return "1970-01-01";
  return d.toISOString().slice(0, 10);
}

/** Ascending list of the last `days` day keys, today included. */
export function dayKeysBack(days, now = Date.now()) {
  const n = Math.max(1, Math.min(366, Math.round(Number(days) || 7)));
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(dayKeyOf(now - i * 86400000));
  }
  return out;
}

function zeroTokens() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
}

function addTokens(target, sample) {
  target.input += sample.i;
  target.cacheRead += sample.cr;
  target.cacheWrite += sample.cw;
  target.output += sample.o;
  target.total += sampleTokens(sample);
}

export class Ledger {
  /**
   * @param {{dir:string, log?:(msg:string, extra?:any)=>void}} options
   */
  constructor(options) {
    this.dir = options.dir;
    this.log = options.log || (() => {});
    /** @type {Map<string, any>} */
    this.samples = new Map();
    this.book = EMPTY_BOOK;
    this.loadedAt = 0;
    this.dirty = false;
  }

  get samplesFile() {
    return join(this.dir, SAMPLES_FILE);
  }

  get bookFile() {
    return join(this.dir, BOOK_FILE);
  }

  /** Load samples + price book from disk. Never throws on bad input. */
  load() {
    ensureDir(this.dir);
    this.samples.clear();
    for (const row of readLines(this.samplesFile)) {
      if (!row || typeof row.k !== "string") continue;
      this.samples.set(row.k, row);
    }
    const book = readJson(this.bookFile, EMPTY_BOOK);
    this.book = book && Array.isArray(book.rows) ? book : { ...EMPTY_BOOK };
    this.loadedAt = Date.now();
    this.log("ledger loaded: " + this.samples.size + " samples, " + this.book.rows.length + " price rows");
    return this;
  }

  /**
   * Ingest one session event if it carries usage.
   * @returns {null | object} the stored sample
   */
  ingest(sessionId, event) {
    const sample = sampleFromEvent(sessionId, event);
    if (!sample) return null;
    const previous = this.samples.get(sample.k);
    if (
      previous &&
      previous.i === sample.i &&
      previous.cr === sample.cr &&
      previous.cw === sample.cw &&
      previous.o === sample.o
    ) {
      return null; // identical re-emit: nothing to record
    }
    this.samples.set(sample.k, sample);
    try {
      appendLine(this.samplesFile, sample);
    } catch (err) {
      this.log("append failed", err);
    }
    this.dirty = true;
    return sample;
  }

  /** The price book as the UI sees it. */
  prices() {
    return this.book;
  }

  /**
   * Create or update one price row. Manual rows always win the lookup order.
   * @param {{provider:string, model:string, buckets?:any, tiers?:any, note?:string, verifiedAt?:number}} input
   */
  setPrice(input) {
    const provider = String(input.provider || "").trim();
    const model = String(input.model || "").trim();
    if (provider === "" || model === "") throw new Error("provider 和 model 不能为空");

    const rows = this.book.rows.filter(
      (r) =>
        !(
          String(r.provider || "").toLowerCase() === provider.toLowerCase() &&
          String(r.model || "").toLowerCase() === model.toLowerCase()
        )
    );
    const row = {
      provider,
      model,
      currency: "CNY",
      unit: "1M",
      buckets: input.buckets ?? null,
      tiers: Array.isArray(input.tiers) && input.tiers.length > 0 ? input.tiers : null,
      source: "manual",
      sourceUrl: null,
      fetchedAt: null,
      verifiedAt: input.verifiedAt ?? Date.now(),
      confidence: CONF.EXACT,
      note: String(input.note || "").trim() || null
    };
    rows.push(row);
    this.book = { ...this.book, rows, meta: { ...(this.book.meta || {}), updatedAt: Date.now() } };
    this.saveBook();
    return row;
  }

  /** Remove a price row entirely (back to unpriced). */
  removePrice(provider, model) {
    const before = this.book.rows.length;
    const rows = this.book.rows.filter(
      (r) =>
        !(
          String(r.provider || "").toLowerCase() === String(provider || "").toLowerCase() &&
          String(r.model || "").toLowerCase() === String(model || "").toLowerCase()
        )
    );
    this.book = { ...this.book, rows, meta: { ...(this.book.meta || {}), updatedAt: Date.now() } };
    this.saveBook();
    return { removed: before - rows.length };
  }

  saveBook() {
    writeJsonAtomic(this.bookFile, this.book);
  }

  /**
   * Aggregate a window.
   * @param {{days?:number, now?:number}} [options]
   */
  summary(options = {}) {
    const days = options.days ?? 7;
    const now = options.now ?? Date.now();
    const keys = dayKeysBack(days, now);
    const index = new Map();
    for (const key of keys) {
      index.set(key, {
        day: key,
        micro: 0,
        tokens: zeroTokens(),
        unpricedTokens: 0,
        confidence: CONF.EXACT,
        byModel: new Map()
      });
    }

    const monthPrefix = dayKeyOf(now).slice(0, 7);
    const kpi = {
      todayMicro: 0,
      windowMicro: 0,
      monthMicro: 0,
      todayTokens: 0,
      windowTokens: 0,
      monthTokens: 0,
      unpricedTokens: 0,
      samples: 0,
      cacheHitRate: 0,
      coverage: CONF.EXACT
    };
    let promptTotal = 0;
    let cacheReadTotal = 0;

    for (const sample of this.samples.values()) {
      const priced = priceSample(this.book, sample);
      const tokens = sampleTokens(sample);
      const day = dayKeyOf(sample.ts);
      const slot = index.get(day);

      kpi.samples += 1;
      kpi.coverage = worstConfidence(kpi.coverage, priced.confidence);
      if (priced.micro == null) kpi.unpricedTokens += tokens;

      if (day.startsWith(monthPrefix)) {
        kpi.monthTokens += tokens;
        if (priced.micro != null) kpi.monthMicro += priced.micro;
      }

      if (!slot) continue;

      slot.tokens.total += tokens;
      slot.tokens.input += sample.i;
      slot.tokens.cacheRead += sample.cr;
      slot.tokens.cacheWrite += sample.cw;
      slot.tokens.output += sample.o;
      slot.confidence = worstConfidence(slot.confidence, priced.confidence);
      promptTotal += sample.i + sample.cr + sample.cw;
      cacheReadTotal += sample.cr;
      if (priced.micro != null) slot.micro += priced.micro;
      else slot.unpricedTokens += tokens;

      const key = sample.pr + "/" + sample.m;
      let bucket = slot.byModel.get(key);
      if (!bucket) {
        bucket = {
          provider: sample.pr,
          model: sample.m,
          tokens: zeroTokens(),
          micro: 0,
          priced: 0,
          confidence: CONF.EXACT,
          source: priced.row ? priced.row.source || null : null,
          note: priced.row ? priced.row.note || null : null,
          how: priced.how || null
        };
        slot.byModel.set(key, bucket);
      }
      addTokens(bucket.tokens, sample);
      bucket.confidence = worstConfidence(bucket.confidence, priced.confidence);
      if (priced.micro != null) {
        bucket.micro += priced.micro;
        bucket.priced += 1;
      }
    }

    kpi.cacheHitRate = promptTotal > 0 ? cacheReadTotal / promptTotal : 0;
    kpi.todayMicro = index.get(dayKeyOf(now)) ? index.get(dayKeyOf(now)).micro : 0;
    kpi.todayTokens = index.get(dayKeyOf(now)) ? index.get(dayKeyOf(now)).tokens.total : 0;
    kpi.windowMicro = [...index.values()].reduce((sum, d) => sum + d.micro, 0);
    kpi.windowTokens = [...index.values()].reduce((sum, d) => sum + d.tokens.total, 0);
    kpi.monthMicro = Math.round(kpi.monthMicro);
    if (kpi.unpricedTokens > 0) kpi.coverage = CONF.UNPRICED;

    const daysOut = [...index.values()].map((slot) => ({
      day: slot.day,
      micro: slot.micro,
      tokens: slot.tokens,
      unpricedTokens: slot.unpricedTokens,
      confidence: slot.confidence,
      byModel: [...slot.byModel.values()].sort((a, b) => b.tokens.total - a.tokens.total)
    }));

    // Window-wide per-model totals: the "哪個模型最贵" table reads this, not
    // the per-day buckets, so it stays stable across the day range.
    const windowModels = new Map();
    for (const slot of daysOut) {
      for (const bucket of slot.byModel) {
        const key = bucket.provider + "/" + bucket.model;
        let agg = windowModels.get(key);
        if (!agg) {
          agg = {
            provider: bucket.provider,
            model: bucket.model,
            tokens: zeroTokens(),
            micro: 0,
            priced: 0,
            confidence: bucket.confidence,
            source: bucket.source,
            note: bucket.note,
            how: bucket.how
          };
          windowModels.set(key, agg);
        }
        agg.tokens.input += bucket.tokens.input;
        agg.tokens.cacheRead += bucket.tokens.cacheRead;
        agg.tokens.cacheWrite += bucket.tokens.cacheWrite;
        agg.tokens.output += bucket.tokens.output;
        agg.tokens.total += bucket.tokens.total;
        agg.micro += bucket.micro;
        agg.priced += bucket.tokens.total;
        agg.confidence = worstConfidence(agg.confidence, bucket.confidence);
      }
    }

    return {
      generatedAt: Date.now(),
      days: daysOut,
      models: [...windowModels.values()].sort((a, b) => b.tokens.total - a.tokens.total),
      kpi,
      priceRows: this.book.rows.length,
      samplesTotal: this.samples.size
    };
  }

  /** One day, split per turn. */
  dayDetail(day) {
    const key = String(day || dayKeyOf(Date.now()));
    const turns = new Map();
    for (const sample of this.samples.values()) {
      if (dayKeyOf(sample.ts) !== key) continue;
      const priced = priceSample(this.book, sample);
      let turn = turns.get(sample.t);
      if (!turn) {
        turn = { turn: sample.t, micro: 0, tokens: zeroTokens(), unpricedTokens: 0, models: [] };
        turns.set(sample.t, turn);
      }
      const tokens = sampleTokens(sample);
      addTokens(turn.tokens, sample);
      if (priced.micro != null) turn.micro += priced.micro;
      else turn.unpricedTokens += tokens;
      turn.models.push({
        provider: sample.pr,
        model: sample.m,
        tokens,
        micro: priced.micro,
        confidence: priced.confidence
      });
    }
    return {
      day: key,
      turns: [...turns.values()].sort((a, b) => a.turn - b.turn)
    };
  }

  /** One session, split per turn. */
  sessionDetail(sessionId) {
    const id = String(sessionId || "");
    const turns = new Map();
    for (const sample of this.samples.values()) {
      if (sample.s !== id) continue;
      const priced = priceSample(this.book, sample);
      let turn = turns.get(sample.t);
      if (!turn) {
        turn = { turn: sample.t, micro: 0, tokens: zeroTokens(), unpricedTokens: 0, models: [] };
        turns.set(sample.t, turn);
      }
      const tokens = sampleTokens(sample);
      addTokens(turn.tokens, sample);
      if (priced.micro != null) turn.micro += priced.micro;
      else turn.unpricedTokens += tokens;
      turn.models.push({
        provider: sample.pr,
        model: sample.m,
        tokens,
        micro: priced.micro,
        confidence: priced.confidence
      });
    }
    return { session: id, turns: [...turns.values()].sort((a, b) => a.turn - b.turn) };
  }

  /** Models seen in the ledger, with their pricing state — drives the "补价" list. */
  modelIndex() {
    const map = new Map();
    for (const sample of this.samples.values()) {
      const key = sample.pr + "/" + sample.m;
      let row = map.get(key);
      if (!row) {
        const priced = priceSample(this.book, sample);
        row = {
          provider: sample.pr,
          model: sample.m,
          tokens: 0,
          samples: 0,
          confidence: priced.confidence,
          priced: priced.micro != null
        };
        map.set(key, row);
      }
      row.tokens += sampleTokens(sample);
      row.samples += 1;
    }
    return [...map.values()].sort((a, b) => b.tokens - a.tokens);
  }

  /** Health/diagnostics. */
  stats() {
    const models = this.modelIndex();
    return {
      samples: this.samples.size,
      sessions: new Set([...this.samples.values()].map((s) => s.s)).size,
      models: models.length,
      unpricedModels: models.filter((m) => !m.priced).length,
      unpricedTokens: models.filter((m) => !m.priced).reduce((sum, m) => sum + m.tokens, 0),
      priceRows: this.book.rows.length,
      firstTs: [...this.samples.values()].reduce((min, s) => (min == null || s.ts < min ? s.ts : min), null),
      lastTs: [...this.samples.values()].reduce((max, s) => (max == null || s.ts > max ? s.ts : max), null),
      dir: this.dir
    };
  }
}