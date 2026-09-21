import uWS from "uWebSockets.js";
import type { StoreApi } from "./storeapi.js";
import { handle, Reply, CORS_ORIGIN } from "./app.js";

const MAX_BODY = 4096;
const MAX_BULK_BODY = 1 << 20;

const STATUS: Record<number, string> = {
  200: "200 OK",
  201: "201 Created",
  204: "204 No Content",
  302: "302 Found",
  400: "400 Bad Request",
  404: "404 Not Found",
  409: "409 Conflict",
  413: "413 Content Too Large",
};

const METHODS: Record<string, string> = {
  get: "GET",
  post: "POST",
  patch: "PATCH",
  delete: "DELETE",
  options: "OPTIONS",
};

function respond(res: uWS.HttpResponse, reply: Reply): void {
  res.writeStatus(STATUS[reply.status] ?? "500 Internal Server Error");
  res.writeHeader("access-control-allow-origin", CORS_ORIGIN);
  res.writeHeader(
    "access-control-allow-methods",
    "GET,POST,PATCH,DELETE,OPTIONS"
  );
  res.writeHeader("access-control-allow-headers", "content-type");
  res.writeHeader("access-control-max-age", "86400");
  if (reply.location !== undefined) {
    res.writeHeader("location", reply.location);
    res.end();
    return;
  }
  res.writeHeader("content-type", reply.ctype ?? "application/json");
  res.end(reply.body);
}

export function createUwsApp(store: StoreApi): uWS.TemplatedApp {
  return uWS.App().any("/*", (res, req) => {
    const method = METHODS[req.getMethod()] ?? "OTHER";
    const url = req.getUrl();
    const qs = req.getQuery();
    const path = qs ? `${url}?${qs}` : url;
    const admin = req.getHeader("x-admin-token") || undefined;
    if (method === "POST" || method === "PATCH") {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      res.onAborted(() => {
        done = true;
      });
      const limit = url === "/api/shorten/bulk" ? MAX_BULK_BODY : MAX_BODY;
      res.onData((chunk, isLast) => {
        if (done) return;
        size += chunk.byteLength;
        if (size > limit) {
          done = true;
          res.cork(() =>
            respond(res, { status: 413, body: '{"error":"body too large"}' })
          );
          return;
        }
        chunks.push(Buffer.from(chunk.slice(0))); // copy: uWS reuses the ArrayBuffer
        if (isLast) {
          const raw =
            chunks.length === 1
              ? chunks[0].toString()
              : Buffer.concat(chunks).toString();
          void handle(store, method, path, raw, admin).then((r) => {
            if (done) return;
            res.cork(() => respond(res, r));
          });
        }
      });
      return;
    }
    let done = false;
    res.onAborted(() => {
      done = true;
    });
    void handle(store, method, path, undefined, admin).then((r) => {
      if (done) return;
      res.cork(() => respond(res, r));
    });
  });
}
