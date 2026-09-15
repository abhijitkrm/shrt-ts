import uWS from "uWebSockets.js";
import { Store } from "./store.js";
import { handle, Reply } from "./app.js";

const MAX_BODY = 4096;
const MAX_BULK_BODY = 1 << 20;

const STATUS: Record<number, string> = {
  200: "200 OK",
  201: "201 Created",
  302: "302 Found",
  400: "400 Bad Request",
  404: "404 Not Found",
  409: "409 Conflict",
  413: "413 Content Too Large",
};

function respond(res: uWS.HttpResponse, reply: Reply): void {
  res.writeStatus(STATUS[reply.status] ?? "500 Internal Server Error");
  if (reply.location !== undefined) {
    res.writeHeader("location", reply.location);
    res.end();
    return;
  }
  res.writeHeader("content-type", "application/json");
  res.end(reply.body);
}

export function createUwsApp(store: Store): uWS.TemplatedApp {
  return uWS.App().any("/*", (res, req) => {
    const m = req.getMethod();
    const method = m === "get" ? "GET" : m === "post" ? "POST" : "OTHER";
    const path = req.getUrl();
    if (method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      res.onAborted(() => {
        done = true;
      });
      const limit = path === "/api/shorten/bulk" ? MAX_BULK_BODY : MAX_BODY;
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
          res.cork(() => respond(res, handle(store, method, path, raw)));
        }
      });
      return;
    }
    respond(res, handle(store, method, path));
  });
}
