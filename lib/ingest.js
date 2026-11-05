/**
 * Event -> usage sample.
 *
 * The ONLY authoritative source of token usage is the harness's
 * `assistant/message` event: one per model step, carrying
 * `data.usage = { inputTokens, cacheReadTokens, outputTokens, ... }` and
 * `data.message.source = { provider, model }`.
 *
 * Deliberately NOT reading `assistant/chunk` usage chunks: those are
 * incremental and would double count against the final message. One step must
 * produce exactly one sample.
 *
 * Deliberately NOT adding reasoningTokens to outputTokens: the harness
 * guarantees `reasoningTokens ⊆ outputTokens`, so adding both bills the
 * reasoning twice (a real bug observed in another plugin).
 *
 * @module dsh-cost-ledger/ingest
 */

/** The one event type that carries a billable step. */
export const USAGE_EVENT = "assistant/message";

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Turn a session event into a usage sample.
 * @param {string} sessionId
 * @param {any} event
 * @returns {null | {k:string,s:string,t:number,p:number,ts:number,pr:string,m:string,i:number,cr:number,cw:number,o:number}}
 */
export function sampleFromEvent(sessionId, event) {
  if (!event || event.type !== USAGE_EVENT) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;

  const usage = data.usage;
  if (!usage || typeof usage !== "object") return null;

  const turn = Number(data.turn);
  const step = Number(data.step);
  if (!Number.isFinite(turn) || !Number.isFinite(step)) return null;

  const source = (data.message && data.message.source) || {};
  const provider = str(source.provider) || "unknown";
  const model = str(source.model) || "unknown";

  const i = num(usage.inputTokens);
  const cr = num(usage.cacheReadTokens);
  const cw = num(usage.cacheWriteTokens);
  const o = num(usage.outputTokens);
  if (i + cr + cw + o <= 0) return null;

  const ts = Number(event.time) || Date.now();
  return {
    k: sessionId + ":" + turn + ":" + step,
    s: String(sessionId || "unknown"),
    t: turn,
    p: step,
    ts,
    pr: provider,
    m: model,
    i,
    cr,
    cw,
    o
  };
}

/** Total billed tokens of a sample. */
export function sampleTokens(sample) {
  return sample.i + sample.cr + sample.cw + sample.o;
}

/** Prompt-side tokens (what tiered pricing keys on). */
export function promptTokens(sample) {
  return sample.i + sample.cr + sample.cw;
}