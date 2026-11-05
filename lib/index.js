/**
 * dsh-cost-ledger — host half.
 *
 * Responsibility: subscribe to `session/event`, turn billable steps into
 * samples, keep the ledger + price book on disk, and serve the
 * /api/cost-ledger/* endpoints the browser half renders.
 *
 * No `@deepseek-ai/*` imports on purpose: a `link:`-installed plugin resolves
 * modules from its own directory, so depending on a harness package would make
 * the plugin fail to load exactly in the development setup we ship. Node
 * builtins only.
 *
 * @module dsh-cost-ledger
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillSessions } from "./backfill.js";
import { Ledger } from "./ledger.js";
import { registerRoutes } from "./routes.js";

/** Stable Cordis plugin name. */
export const name = "cost-ledger";

/** Services required before this plugin activates. */
export const inject = ["webServer"];

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_BOOK = join(HERE, "..", "data", "prices.seed.json");

/** DSH_HOME, mirroring the harness's own resolution. */
export function resolveHome(env = process.env) {
  const configured = env.DSH_HOME;
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  return join(homedir(), ".dsh");
}

/**
 * Seed the live price book on first run so the user sees their own models (as
 * visibly unpriced rows to fill in) instead of an empty screen.
 */
function seedBookIfMissing(dir) {
  try {
    const target = join(dir, "prices.json");
    if (existsSync(target)) return;
    mkdirSync(dir, { recursive: true });
    if (existsSync(SEED_BOOK)) copyFileSync(SEED_BOOK, target);
  } catch {
    /* seeding is a convenience, never fatal */
  }
}

/**
 * @param {any} ctx cordis context
 * @param {{dataDir?:string, backfillOnStart?:boolean}} [config]
 */
export function apply(ctx, config = {}) {
  const home = resolveHome();
  const dir = config.dataDir ? String(config.dataDir) : join(home, "cost-ledger");

  const log = (message) => {
    try {
      if (typeof ctx.logger === "function") ctx.logger("[cost-ledger] " + message);
      else if (ctx.logger && typeof ctx.logger.info === "function") ctx.logger.info("[cost-ledger] " + message);
    } catch {
      /* logging must never break the plugin */
    }
  };

  seedBookIfMissing(dir);

  const ledger = new Ledger({ dir, log });
  ledger.load();

  ctx.effect(
    () =>
      ctx.on("session/event", (session, event) => {
        try {
          ledger.ingest(session && session.id ? session.id : "unknown", event);
        } catch (err) {
          log("ingest failed: " + (err && err.message ? err.message : String(err)));
        }
      }),
    "cost-ledger: session events"
  );

  registerRoutes(ctx, ledger, { home });

  // Backfill in the background on a cold ledger so the first paint has history.
  if (config.backfillOnStart !== false && ledger.samples.size === 0) {
    setTimeout(() => {
      try {
        const result = backfillSessions(ledger, home);
        log("backfill: " + result.samples + " samples from " + result.files + " files");
      } catch (err) {
        log("backfill failed: " + (err && err.message ? err.message : String(err)));
      }
    }, 1500);
  }

  log("ready at " + dir);
  return { ledger, dir };
}