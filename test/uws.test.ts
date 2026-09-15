import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import uWS from "uWebSockets.js";
import { Store } from "../src/store.js";
import { createUwsApp } from "../src/uws.js";

const PORT = 4567;
const base = `http://127.0.0.1:${PORT}`;
let sock: uWS.us_listen_socket | null = null;
let store: Store;

before(async () => {
  store = new Store(":memory:");
  const app = createUwsApp(store);
  await new Promise<void>((resolve, reject) => {
    app.listen(PORT, (s) => {
      if (!s) return reject(new Error("uws listen failed"));
      sock = s;
      resolve();
    });
  });
});

after(() => {
  if (sock) uWS.us_listen_socket_close(sock);
  store.close();
});

test("uws: shorten -> redirect -> stats", async () => {
  const res = await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://uws.example/path" }),
  });
  assert.equal(res.status, 201);
  const { code } = await res.json();

  const redir = await fetch(`${base}/${code}`, { redirect: "manual" });
  assert.equal(redir.status, 302);
  assert.equal(redir.headers.get("location"), "https://uws.example/path");

  const stats = await fetch(`${base}/api/stats/${code}`);
  assert.equal(stats.status, 200);
  assert.equal((await stats.json()).hits, 1);
});

test("uws: 404 and 400 paths", async () => {
  assert.equal((await fetch(`${base}/missing`)).status, 404);
  const bad = await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{oops",
  });
  assert.equal(bad.status, 400);
});
