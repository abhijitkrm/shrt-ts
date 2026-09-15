import {
  createServer,
  IncomingMessage,
  ServerResponse,
  Server,
} from "node:http";
import { Store } from "./store.js";

const CODE_RE = /^[0-9A-Za-z_-]{1,64}$/;
const MAX_BODY = 4096;
const MAX_BULK_BODY = 1 << 20;
const MAX_BULK_URLS = 10_000;

export interface Reply {
  status: number;
  location?: string;
  body?: string;
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

function shortenOne(
  store: Store,
  parsed: { url?: unknown; alias?: unknown; ttl_ms?: unknown }
): Reply {
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
  const code = store.shorten(
    parsed.url,
    parsed.alias as string | undefined,
    parsed.ttl_ms as number | undefined
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

function shortenBulk(store: Store, parsed: { urls?: unknown }): Reply {
  if (
    !Array.isArray(parsed.urls) ||
    parsed.urls.length === 0 ||
    parsed.urls.length > MAX_BULK_URLS ||
    !parsed.urls.every(okBulkUrl)
  ) {
    return bad(`urls must be 1-${MAX_BULK_URLS} valid http(s) urls`);
  }
  const codes = store.shortenMany(parsed.urls);
  return { status: 201, body: JSON.stringify({ count: codes.length, codes }) };
}

/** Transport-agnostic request handler shared by node:http and uWS. */
export function handle(
  store: Store,
  method: string,
  path: string,
  body?: string
): Reply {
  if (method === "GET") {
    if (path === "/api/health") return { status: 200, body: '{"ok":true}' };
    if (path.startsWith("/api/stats/")) {
      const link = store.stats(path.slice(11));
      return link
        ? { status: 200, body: JSON.stringify(link) }
        : { status: 404, body: '{"error":"not found"}' };
    }
    const code = path.slice(1);
    const target = CODE_RE.test(code) ? store.resolve(code) : null;
    return target === null
      ? { status: 404, body: '{"error":"not found"}' }
      : { status: 302, location: target };
  }

  if (method === "POST") {
    if (path !== "/api/shorten" && path !== "/api/shorten/bulk") {
      return { status: 404, body: '{"error":"not found"}' };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body ?? "");
    } catch {
      return bad("invalid json");
    }
    return path === "/api/shorten"
      ? shortenOne(store, parsed)
      : shortenBulk(store, parsed);
  }

  return { status: 404, body: '{"error":"not found"}' };
}

function send(res: ServerResponse, reply: Reply): void {
  if (reply.location !== undefined) {
    res.writeHead(reply.status, { location: reply.location });
    res.end();
    return;
  }
  res.writeHead(reply.status, { "content-type": "application/json" });
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

export function createApp(store: Store): Server {
  return createServer((req, res) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    if (method === "POST") {
      const limit = path === "/api/shorten/bulk" ? MAX_BULK_BODY : MAX_BODY;
      readBody(req, res, limit, (raw) =>
        send(res, handle(store, method, path, raw))
      );
    } else {
      send(res, handle(store, method, path));
    }
  });
}
