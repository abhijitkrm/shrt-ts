import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { createApp } from "../src/app.js";

let base: string;
let close: () => void;

before(async () => {
  const store = new Store(":memory:");
  const server = createApp(store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  close = () => {
    server.closeAllConnections();
    server.close(() => store.close());
  };
});

after(() => close());

test("health", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("shorten -> redirect -> stats flow", async () => {
  const res = await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/some/path" }),
  });
  assert.equal(res.status, 201);
  const { code, short_url } = await res.json();
  assert.equal(typeof code, "string");
  assert.equal(short_url, `/${code}`);

  const redir = await fetch(`${base}/${code}`, { redirect: "manual" });
  assert.equal(redir.status, 302);
  assert.equal(redir.headers.get("location"), "https://example.com/some/path");

  const stats = await fetch(`${base}/api/stats/${code}`);
  assert.equal(stats.status, 200);
  const body = await stats.json();
  assert.equal(body.url, "https://example.com/some/path");
  assert.equal(body.hits, 1);
});

test("custom alias", async () => {
  const res = await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://a.com", alias: "cool" }),
  });
  assert.equal(res.status, 201);
  const redir = await fetch(`${base}/cool`, { redirect: "manual" });
  assert.equal(redir.headers.get("location"), "https://a.com");

  const dup = await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://b.com", alias: "cool" }),
  });
  assert.equal(dup.status, 409);
});

test("rejects invalid url", async () => {
  for (const url of ["notaurl", "ftp://x.com", "javascript:alert(1)"]) {
    const res = await fetch(`${base}/api/shorten`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    assert.equal(res.status, 400, url);
  }
});

test("rejects invalid json and missing url", async () => {
  const res = await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{bad",
  });
  assert.equal(res.status, 400);
  const res2 = await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res2.status, 400);
});

test("404 for unknown code and bad paths", async () => {
  assert.equal((await fetch(`${base}/zzz`)).status, 404);
  assert.equal((await fetch(`${base}/api/stats/zzz`)).status, 404);
  assert.equal((await fetch(`${base}/a/b/c`)).status, 404);
});

test("bulk shorten", async () => {
  const urls = Array.from({ length: 50 }, (_, i) => `https://bulk.example/${i}`);
  const res = await fetch(`${base}/api/shorten/bulk`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ urls }),
  });
  assert.equal(res.status, 201);
  const { count, codes } = await res.json();
  assert.equal(count, 50);
  assert.equal(new Set(codes).size, 50);
  const redir = await fetch(`${base}/${codes[10]}`, { redirect: "manual" });
  assert.equal(redir.headers.get("location"), urls[10]);
});

test("bulk rejects bad input", async () => {
  for (const urls of [[], ["ftp://x"], ["https://ok.com", "nope"], "notarray"]) {
    const res = await fetch(`${base}/api/shorten/bulk`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls }),
    });
    assert.equal(res.status, 400, JSON.stringify(urls));
  }
});

test("rejects oversized body", async () => {
  const res = await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://x.com/" + "a".repeat(5000) }),
  });
  assert.ok([400, 413].includes(res.status));
});
