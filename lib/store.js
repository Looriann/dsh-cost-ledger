/**
 * Tiny file-backed store: atomic JSON writes and append-only NDJSON.
 *
 * Why not a database in M1: the whole ledger is a few thousand lines, and a
 * text file can be opened, diffed and repaired by hand. `writeJsonAtomic`
 * keeps a half-written file from ever being read (write to .tmp, then rename,
 * which is atomic on NTFS and POSIX alike).
 *
 * @module dsh-cost-ledger/store
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

/** Create a directory (recursive, idempotent). */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/**
 * Read a JSON document, tolerating a missing or corrupt file.
 * A corrupt file is copied to `<name>.bak` before the fallback is returned, so
 * the user's data is never silently destroyed by a parse error.
 * @param {string} file absolute path
 * @param {any} fallback value returned when the file is missing/corrupt
 */
export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const text = readFileSync(file, "utf8");
    if (text.trim() === "") return fallback;
    return JSON.parse(text);
  } catch (err) {
    try {
      copyFileSync(file, file + ".bak");
    } catch {
      /* best effort */
    }
    return fallback;
  }
}

/** Write JSON through a temp file + rename so readers never see a partial file. */
export function writeJsonAtomic(file, value) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/** Append one JSON object as a line. */
export function appendLine(file, obj) {
  appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

/** Read an NDJSON file into an array, skipping unparsable lines. */
export function readLines(file) {
  const out = [];
  if (!existsSync(file)) return out;
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** Join a data directory with a file name. */
export function dataFile(dir, name) {
  return join(dir, name);
}