// Tests for the embedded RocksDB backend — in-process, no server.
//   pnpm test
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RocksStore } from "../src/rocksstore.js";

let seq = 0;
const open = () =>
  RocksStore.open(join(mkdtempSync(join(tmpdir(), "shrt-rocks-")), "db"), 0, 1000, 50);

test("rocks shorten/resolve/alias", async () => {
  const st = await open();
  try {
    assert.equal(await st.shorten("https://a.com", "gh", 0), "gh");
    assert.equal(await st.resolve("gh"), "https://a.com");
    assert.equal(await st.shorten("https://b.com", "gh", 0), null);
    const c = await st.shorten("https://c.com");
    assert.ok(c);
    assert.equal(await st.resolve(c), "https://c.com");
  } finally { st.close(); }
});

test("rocks hits batched", async () => {
  const st = await open();
  try {
    await st.shorten("https://a.com", "h", 0);
    for (let i = 0; i < 5; i++) await st.resolve("h");
    await st.flush();
    const s = await st.stats("h");
    assert.equal(s?.hits, 5);
  } finally { st.close(); }
});

test("rocks update/remove", async () => {
  const st = await open();
  try {
    await st.shorten("https://a.com", "u", 0);
    assert.equal(await st.update("u", "https://b.com", 0), "ok");
    assert.equal(await st.resolve("u"), "https://b.com");
    assert.equal(await st.update("missing", "https://x.com", 0), "missing");
    assert.equal(await st.remove("u"), "ok");
    assert.equal(await st.resolve("u"), null);
    assert.equal(await st.remove("u"), "missing");
  } finally { st.close(); }
});

test("rocks ttl", async () => {
  const st = await open();
  try {
    await st.shorten("https://t.com", "ttl", 80);
    assert.ok(await st.resolve("ttl"));
    await new Promise((r) => setTimeout(r, 130));
    assert.equal(await st.resolve("ttl"), null);
  } finally { st.close(); }
});

test("rocks list/stats", async () => {
  const st = await open();
  try {
    await st.shorten("https://one.com", "one", 0);
    await st.shorten("https://two.com", "two", 0);
    await st.resolve("one");
    await st.flush();
    const r = await st.list(10, 0, "created");
    assert.equal(r.total, 2);
    const one = r.links.find((l) => l.code === "one");
    assert.equal(one?.hits, 1);
    const s = await st.stats("two");
    assert.equal(s?.url, "https://two.com");
    assert.ok(s!.created_at > 0);
  } finally { st.close(); }
});

test("rocks bulk + cold miss", async () => {
  const st = await open();
  try {
    const urls = Array.from({ length: 100 }, (_, i) => `https://b.example/${i}`);
    const codes = await st.shortenMany(urls, 0);
    const seen = new Set<string>();
    for (let i = 0; i < urls.length; i++) {
      assert.ok(codes[i]);
      assert.ok(!seen.has(codes[i]));
      seen.add(codes[i]);
      assert.equal(await st.resolve(codes[i]), urls[i]);
    }
    assert.equal(await st.resolve("nope-missing"), null);
  } finally { st.close(); }
});

test("rocks restart persists corpus + hits", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "shrt-rocks-")), "db");
  const s1 = await RocksStore.open(dir, 0, 1000, 50);
  await s1.shorten("https://keep.com", "keep", 0);
  await s1.resolve("keep");
  await s1.flush();
  s1.close();
  const s2 = await RocksStore.open(dir, 0, 1000, 50);
  try {
    assert.equal(await s2.resolve("keep"), "https://keep.com");
    const st = await s2.stats("keep");
    assert.equal(st?.hits, 2);
  } finally { s2.close(); }
});
