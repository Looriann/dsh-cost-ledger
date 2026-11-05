/**
 * Backfill: read the harness's on-disk session logs so the ledger is useful on
 * day one instead of starting from zero.
 *
 * Session files are `<DSH_HOME>/sessions/<workspace>/<session-id>/session.v4.jsonl.zstd`.
 * They are MULTI-FRAME zstd: the harness appends one frame per batch of events,
 * so a naive `zstdDecompressSync(wholeFile)` returns only the first frame (this
 * bit us: a 149-event session decompressed to a single `{"session":1}` line).
 * We split on the zstd magic number and decompress each frame.
 *
 * Every failure is soft: an unreadable file is skipped, never fatal.
 *
 * @module dsh-cost-ledger/backfill
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** All session log files under `<home>/sessions` (or an explicit root). */
export function listSessionFiles(home, sessionsRoot) {
  const root = sessionsRoot || join(home, "sessions");
  if (!existsSync(root)) return [];
  const files = [];
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(root, workspace.name);
    let sessions = [];
    try {
      sessions = readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = join(workspaceDir, session.name);
      let entries = [];
      try {
        entries = readdirSync(sessionDir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.endsWith(".jsonl.zstd") || name.endsWith(".jsonl")) {
          files.push(join(sessionDir, name));
        }
      }
    }
  }
  return files;
}

/** Split a multi-frame zstd buffer into per-frame buffers. */
export function splitZstdFrames(buffer) {
  const offsets = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const hit = buffer.indexOf(ZSTD_MAGIC, cursor);
    if (hit < 0) break;
    offsets.push(hit);
    cursor = hit + 4;
  }
  if (offsets.length === 0) return [];
  return offsets.map((start, i) => buffer.subarray(start, i + 1 < offsets.length ? offsets[i + 1] : buffer.length));
}

/**
 * Decode one session file into events.
 * @returns {any[]}
 */
export function readSessionEvents(file) {
  let text = "";
  try {
    const buffer = readFileSync(file);
    if (file.endsWith(".zstd")) {
      const frames = splitZstdFrames(buffer);
      const parts = [];
      for (const frame of frames) {
        try {
          parts.push(zstdDecompressSync(frame).toString("utf8"));
        } catch {
          /* skip a corrupt frame */
        }
      }
      text = parts.join("");
    } else {
      text = buffer.toString("utf8");
    }
  } catch {
    return [];
  }

  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* torn line */
    }
  }
  return events;
}

/** Session id = the directory holding the log. */
export function sessionIdOf(file) {
  return basename(dirname(file));
}

/**
 * Walk every session log and feed the ledger.
 * @param {import('./ledger.js').Ledger} ledger
 * @param {string} home DSH_HOME
 * @param {{since?:number}} [options]
 */
export function backfillSessions(ledger, home, options = {}) {
  const files = listSessionFiles(home);
  const result = { files: files.length, events: 0, samples: 0, failed: 0 };
  for (const file of files) {
    const events = readSessionEvents(file);
    if (events.length === 0) {
      result.failed += 1;
      continue;
    }
    const sessionId = sessionIdOf(file);
    for (const event of events) {
      result.events += 1;
      if (ledger.ingest(sessionId, event)) result.samples += 1;
    }
  }
  return result;
}