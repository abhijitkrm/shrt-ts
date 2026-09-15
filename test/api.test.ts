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

test("GET / serves the UI when ui/index.html exists", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200); // tests run from repo root where ui/ exists
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /<title>shrt/);
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

test("CORS: preflight OPTIONS + headers on responses", async () => {
  const pre = await fetch(`${base}/api/shorten`, { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  assert.match(
    pre.headers.get("access-control-allow-methods") ?? "",
    /DELETE/
  );
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
});

test("list links with pagination, sort, search", async () => {
  const res = await fetch(`${base}/api/links?limit=5&offset=0`);
  assert.equal(res.status, 200);
  const { links, total } = await res.json();
  assert.ok(total >= 1);
  assert.ok(links.length <= 5);
  assert.ok(links[0].code && links[0].url);

  const searched = await fetch(`${base}/api/links?q=${encodeURIComponent("example.com")}`);
  const sBody = await searched.json();
  assert.ok(sBody.links.every((l: any) => l.url.includes("example.com") || l.code.includes("example.com")));

  const top = await fetch(`${base}/api/links?sort=hits&limit=3`);
  const tBody = await top.json();
  const hits = tBody.links.map((l: any) => l.hits);
  assert.deepEqual([...hits].sort((a, b) => b - a), hits);
});

test("PATCH updates url and ttl", async () => {
  const create = await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://before.example" }),
  });
  const { code } = await create.json();

  const patch = await fetch(`${base}/api/links/${code}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://after.example", ttl_ms: 60000 }),
  });
  assert.equal(patch.status, 200);
  const redir = await fetch(`${base}/${code}`, { redirect: "manual" });
  assert.equal(redir.headers.get("location"), "https://after.example");
  const stats = await (await fetch(`${base}/api/stats/${code}`)).json();
  assert.ok(stats.expires_at > Date.now());

  const bad = await fetch(`${base}/api/links/${code}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "notaurl" }),
  });
  assert.equal(bad.status, 400);
  assert.equal(
    (await fetch(`${base}/api/links/nope`, { method: "PATCH", body: "{}" })).status,
    400
  );
});

test("DELETE removes link and frees alias", async () => {
  await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://del.example", alias: "todelete" }),
  });
  const del = await fetch(`${base}/api/links/todelete`, { method: "DELETE" });
  assert.equal(del.status, 204);
  assert.equal((await fetch(`${base}/todelete`)).status, 404);
  assert.equal(
    (await fetch(`${base}/api/links/todelete`, { method: "DELETE" })).status,
    404
  );
  const reuse = await fetch(`${base}/api/shorten`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://new.example", alias: "todelete" }),
  });
  assert.equal(reuse.status, 201);
});
