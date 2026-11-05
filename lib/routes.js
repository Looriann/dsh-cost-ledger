/**
 * HTTP routes for the browser half.
 *
 * Two rules this file enforces:
 *
 * 1. ONE registration per path. `webServer.register` binds an exact path, so
 *    GET/PUT/DELETE on `/prices` share a single handler that dispatches on
 *    method — registering the same path three times would fight over it.
 * 2. Loopback only. The web GUI talks to these routes same-origin and already
 *    needs its own session cookie; the fence here means a stray local process
 *    cannot rewrite the price book either.
 *
 * @module dsh-cost-ledger/routes
 */

import { backfillSessions } from "./backfill.js";

export const PREFIX = "/api/cost-ledger";

function isLoopback(req) {
  const address = (req.socket && req.socket.remoteAddress) || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
      if (text.trim() === "") return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function numberParam(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * @param {any} ctx cordis plugin context (needs `webServer`)
 * @param {import('./ledger.js').Ledger} ledger
 * @param {{home:string}} env
 */
export function registerRoutes(ctx, ledger, env) {
  const basketOf = (body) =>
    body.buckets
      ? {
          input: body.buckets.input ?? null,
          cacheRead: body.buckets.cacheRead ?? null,
          cacheWrite: body.buckets.cacheWrite ?? null,
          output: body.buckets.output ?? null
        }
      : null;

  const endpoints = [
    {
      path: PREFIX + "/summary",
      methods: {
        GET: async (req, res, url) => {
          const days = numberParam(url.searchParams.get("days"), 7, 1, 400);
          sendJson(res, 200, ledger.summary({ days }));
        }
      }
    },
    {
      path: PREFIX + "/day",
      methods: {
        GET: async (req, res, url) => {
          sendJson(res, 200, ledger.dayDetail(url.searchParams.get("day")));
        }
      }
    },
    {
      path: PREFIX + "/session",
      methods: {
        GET: async (req, res, url) => {
          sendJson(res, 200, ledger.sessionDetail(url.searchParams.get("id")));
        }
      }
    },
    {
      path: PREFIX + "/models",
      methods: {
        GET: async (req, res) => {
          sendJson(res, 200, { models: ledger.modelIndex() });
        }
      }
    },
    {
      path: PREFIX + "/prices",
      methods: {
        GET: async (req, res) => {
          sendJson(res, 200, { book: ledger.prices(), models: ledger.modelIndex() });
        },
        PUT: async (req, res) => {
          const body = await readBody(req);
          const row = ledger.setPrice({
            provider: body.provider,
            model: body.model,
            buckets: basketOf(body),
            tiers: body.tiers ?? null,
            note: body.note
          });
          sendJson(res, 200, { ok: true, row });
        },
        DELETE: async (req, res, url) => {
          const result = ledger.removePrice(url.searchParams.get("provider"), url.searchParams.get("model"));
          sendJson(res, 200, { ok: true, ...result });
        }
      }
    },
    {
      path: PREFIX + "/health",
      methods: {
        GET: async (req, res) => {
          sendJson(res, 200, { ok: true, stats: ledger.stats(), book: ledger.prices().rows.length });
        }
      }
    },
    {
      path: PREFIX + "/backfill",
      methods: {
        POST: async (req, res) => {
          const result = backfillSessions(ledger, env.home);
          sendJson(res, 200, { ok: true, ...result, stats: ledger.stats() });
        }
      }
    }
  ];

  const disposers = [];
  for (const endpoint of endpoints) {
    const allowed = Object.keys(endpoint.methods);
    const handler = async (req, res) => {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: "仅允许本机访问" });
        return;
      }
      let url;
      try {
        url = new URL(req.url || "/", "http://127.0.0.1");
      } catch {
        sendJson(res, 400, { ok: false, error: "非法 URL" });
        return;
      }
      const method = (req.method || "GET").toUpperCase();
      const run = endpoint.methods[method];
      if (!run) {
        sendJson(res, 405, { ok: false, error: "方法不允许", allow: allowed });
        return;
      }
      try {
        await run(req, res, url);
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        if (!res.headersSent) sendJson(res, 400, { ok: false, error: message });
        else res.end();
      }
    };
    disposers.push(
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: "exact",
            path: endpoint.path,
            handler
          }),
        "cost-ledger: " + endpoint.path
      )
    );
  }
  return disposers;
}