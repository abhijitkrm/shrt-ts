import { limiter, rateLimited, incLimited } from "./ratelimit.js";
import {
  createServer,
  IncomingMessage,
  ServerResponse,
  Server,
} from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoreApi } from "./storeapi.js";
import type { Link } from "./store.js";
import * as metrics from "./metrics.js";

const CODE_RE = /^[0-9A-Za-z_-]{1,64}$/;
const MAX_BODY = 4096;
const MAX_BULK_BODY = 1 << 20;
const MAX_BULK_URLS = 10_000;
const MAX_LIST_LIMIT = 1000;
/** Links expire after at most this long; also the default TTL (1 day). */
const LINK_TTL_MS = Number(process.env.LINK_TTL_MS ?? 86_400_000);

/** Origin for Access-Control-Allow-Origin; "*" = any (dev default). */
export const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";

/**
 * Links are immutable for the public API. PATCH/DELETE exist only when
 * ADMIN_TOKEN is set, and require the x-admin-token header (abuse takedowns).
 */
function adminOk(token?: string): boolean {
  const t = process.env.ADMIN_TOKEN;
  return !!t && token === t;
}

export interface Reply {
  status: number;
  location?: string;
  body?: string;
  ctype?: string;
}

/** Optional single-page UI at GET / — read once, 404 when absent. */
let uiCache: string | null | undefined;
function uiHtml(): string | null {
  if (uiCache === undefined) {
    try {
      uiCache = readFileSync(join(process.cwd(), "ui", "index.html"), "utf8");
    } catch {
      uiCache = null;
    }
  }
  return uiCache;
}

function isValidUrl(raw: string): boolean {
  if (raw.length > 2048) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function bad(error: string): Reply {
  return { status: 400, body: `{"error":"${error}"}` };
}

async function shortenOne(
  store: StoreApi,
  parsed: { url?: unknown; alias?: unknown; ttl_ms?: unknown }
): Promise<Reply> {
  if (typeof parsed.url !== "string" || !isValidUrl(parsed.url)) {
    return bad("invalid url");
  }
  if (
    parsed.alias !== undefined &&
    (typeof parsed.alias !== "string" || !CODE_RE.test(parsed.alias))
  ) {
    return bad("invalid alias");
  }
  if (
    parsed.ttl_ms !== undefined &&
    (typeof parsed.ttl_ms !== "number" || parsed.ttl_ms <= 0)
  ) {
    return bad("invalid ttl_ms");
  }
  const code = await store.shorten(
    parsed.url,
    parsed.alias as string | undefined,
    Math.min(
      (parsed.ttl_ms as number | undefined) ?? LINK_TTL_MS,
      LINK_TTL_MS
    )
  );
  return code === null
    ? { status: 409, body: '{"error":"alias taken"}' }
    : { status: 201, body: JSON.stringify({ code, short_url: "/" + code }) };
}

// bulk fast-path: prefix + length + no chars that could break the log line
const okBulkUrl = (u: unknown): u is string =>
  typeof u === "string" &&
  u.length <= 2048 &&
  u.length > 7 &&
  (u.startsWith("http://") || u.startsWith("https://")) &&
  !/["\\\n\r]/.test(u);

async function shortenBulk(store: StoreApi, parsed: { urls?: unknown }): Promise<Reply> {
  if (
    !Array.isArray(parsed.urls) ||
    parsed.urls.length === 0 ||
    parsed.urls.length > MAX_BULK_URLS ||
    !parsed.urls.every(okBulkUrl)
  ) {
    return bad(`urls must be 1-${MAX_BULK_URLS} valid http(s) urls`);
  }
  const codes = await store.shortenMany(parsed.urls, LINK_TTL_MS);
  metrics.linksDelta(codes.length);
  return { status: 201, body: JSON.stringify({ count: codes.length, codes }) };
}

function parseBody(body?: string): Record<string, unknown> | Reply {
  try {
    return JSON.parse(body ?? "") as Record<string, unknown>;
  } catch {
    return bad("invalid json");
  }
}

const isReply = (v: unknown): v is Reply =>
  typeof (v as Reply).status === "number";

/** Transport-agnostic request handler shared by node:http and uWS.
 *  `client` is the peer IP (or first X-Forwarded-For under TRUST_PROXY)
 *  used for RATE_LIMIT accounting. */
export async function handle(
  store: StoreApi,
  method: string,
  path: string,
  body?: string,
  adminToken?: string,
  client = ""
): Promise<Reply> {
  const r = await route(store, method, path, body, adminToken, client);
  metrics.status(r.status);
  return r;
}

async function route(
  store: StoreApi,
  method: string,
  path: string,
  body: string | undefined,
  adminToken: string | undefined,
  client: string
): Promise<Reply> {
  const q = path.indexOf("?");
  const pathname = q < 0 ? path : path.slice(0, q);
  const query = q < 0 ? "" : path.slice(q + 1);

  metrics.tick();

  if (method === "OPTIONS") return { status: 204 };

  if (method === "GET") {
    if (pathname === "/api/health") {
      metrics.op(7);
      return (await store.healthy())
        ? { status: 200, body: '{"ok":true}' }
        : { status: 503, body: '{"ok":false}' };
    }
    if (pathname === "/api/metrics") {
      metrics.op(8);
      return { status: 200, body: JSON.stringify(metrics.snapshot()) };
    }
    if (pathname === "/metrics") {
      metrics.op(8);
      return {
        status: 200,
        body: metrics.prometheus(rateLimited),
        ctype: "text/plain; version=0.0.4",
      };
    }
    if (pathname === "/") {
      metrics.op(9);
      const html = uiHtml();
      return html === null
        ? { status: 404, body: '{"error":"not found"}' }
        : { status: 200, body: html, ctype: "text/html; charset=utf-8" };
    }
    if (pathname === "/api/links") {
      metrics.op(5);
      const p = new URLSearchParams(query);
      const limit = Math.min(
        Math.max(Number(p.get("limit")) || 50, 1),
        MAX_LIST_LIMIT
      );
      const offset = Math.max(Number(p.get("offset")) || 0, 0);
      const sort = p.get("sort") === "hits" ? "hits" : "created";
      const search = p.get("q") ?? undefined;
      const { links, total } = await store.list(limit, offset, sort, search);
      return { status: 200, body: JSON.stringify({ links, total }) };
    }
    if (pathname.startsWith("/api/stats/")) {
      metrics.op(6);
      const link = await store.stats(pathname.slice(11));
      return link
        ? { status: 200, body: JSON.stringify(link) }
        : { status: 404, body: '{"error":"not found"}' };
    }
    const code = pathname.slice(1);
    metrics.op(0);
    const target = CODE_RE.test(code) ? await store.resolve(code) : null;
    return target === null
      ? { status: 404, body: '{"error":"not found"}' }
      : { status: 302, location: target };
  }

  if (method === "POST") {
    if (pathname !== "/api/shorten" && pathname !== "/api/shorten/bulk") {
      metrics.op(10);
      return { status: 404, body: '{"error":"not found"}' };
    }
    const parsed = parseBody(body);
    if (isReply(parsed)) return parsed;
    const cost =
      pathname === "/api/shorten/bulk" && Array.isArray(parsed.urls)
        ? Math.max(1, parsed.urls.length)
        : 1;
    if (!limiter().allow(client, cost)) {
      incLimited();
      metrics.op(10);
      return { status: 429, body: '{"error":"rate limited"}' };
    }
    metrics.op(pathname === "/api/shorten" ? 1 : 2);
    return pathname === "/api/shorten"
      ? shortenOne(store, parsed)
      : shortenBulk(store, parsed);
  }

  if (method === "PATCH" || method === "DELETE") {
    if (!pathname.startsWith("/api/links/") || !adminOk(adminToken)) {
      return { status: 404, body: '{"error":"not found"}' };
    }
    const code = pathname.slice(11);
    if (!CODE_RE.test(code)) return bad("invalid code");
    if (method === "DELETE") {
      metrics.op(4);
      const r = await store.remove(code);
      if (r === "ok") {
        metrics.linksDelta(-1);
        return { status: 204 };
      }
      return r === "missing"
        ? { status: 404, body: '{"error":"not found"}' }
        : { status: 409, body: '{"error":"owned by another instance"}' };
    }
    const parsed = parseBody(body);
    if (isReply(parsed)) return parsed;
    if (parsed.url !== undefined) {
      if (typeof parsed.url !== "string" || !isValidUrl(parsed.url)) {
        return bad("invalid url");
      }
      metrics.op(3);
      const r = await store.update(
        code,
        parsed.url,
        parsed.ttl_ms === undefined
          ? undefined
          : Math.min(parsed.ttl_ms as number, LINK_TTL_MS)
      );
      if (r === "ok") return { status: 200, body: '{"ok":true}' };
      return r === "missing"
        ? { status: 404, body: '{"error":"not found"}' }
        : { status: 409, body: '{"error":"owned by another instance"}' };
    }
    return bad("nothing to update");
  }

  return { status: 404, body: '{"error":"not found"}' };
}

function send(res: ServerResponse, reply: Reply): void {
  const headers: Record<string, string> = {
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
  if (reply.location !== undefined) headers.location = reply.location;
  else headers["content-type"] = reply.ctype ?? "application/json";
  res.writeHead(reply.status, headers);
  res.end(reply.body);
}

function readBody(
  req: IncomingMessage,
  res: ServerResponse,
  limit: number,
  cb: (raw: string) => void
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > limit) {
      res.writeHead(413);
      res.end();
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", () =>
    cb(
      chunks.length === 1
        ? chunks[0].toString()
        : Buffer.concat(chunks).toString()
    )
  );
  req.on("error", () => res.destroy());
}

const TRUST_PROXY = process.env.TRUST_PROXY !== undefined;

/** Rate-limit key: first X-Forwarded-For hop under TRUST_PROXY, else peer. */
function clientIp(xff: string | string[] | undefined, peer: string): string {
  if (TRUST_PROXY && xff) {
    const v = Array.isArray(xff) ? xff[0] : xff;
    const first = v?.split(",", 1)[0]?.trim();
    if (first) return first;
  }
  return peer;
}

export function createApp(store: StoreApi): Server {
  return createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const token = req.headers["x-admin-token"];
    const admin = Array.isArray(token) ? token[0] : token;
    const client = clientIp(req.headers["x-forwarded-for"],
      req.socket.remoteAddress ?? "");
    if (method === "POST" || method === "PATCH") {
      const pathname = path.split("?", 1)[0];
      const limit = pathname === "/api/shorten/bulk" ? MAX_BULK_BODY : MAX_BODY;
      readBody(req, res, limit, (raw) => {
        void handle(store, method, path, raw, admin, client).then((r) =>
          send(res, r));
      });
    } else {
      void handle(store, method, path, undefined, admin, client).then((r) =>
        send(res, r)
      );
    }
  });
}
