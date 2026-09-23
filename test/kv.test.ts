// Live tests for the RESP-KV backend. Gated on SHRT_KV_ADDR — skipped
// when unset/unreachable so the suite stays hermetic.
//   SHRT_KV_ADDR=127.0.0.1:6379 pnpm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { KvStore } from "../src/kvstore.js";
import { Kv } from "../src/kv.js";

const ADDR = process.env.SHRT_KV_ADDR;
let st: KvStore | null = null;
let skip = false;

before(async () => {
  if (!ADDR) {
    skip = true;
    return;
  }
  try {
    st = await KvStore.open(ADDR, 0, 1000, 50);
    const kv = await Kv.connect(ADDR, 1);
    await kv.flushdb();
    kv.close();
  } catch {
    skip = true;
    st = null;
  }
});

after(() => st?.close());

test("kv shorten/resolve/alias", async (t) => {
  if (skip || !st) return t.skip();
  assert.equal(await st.shorten("https://a.com", "gh", 0), "gh");
  assert.equal(await st.resolve("gh"), "https://a.com");
  assert.equal(await st.shorten("https://b.com", "gh", 0), null);
  const c = await st.shorten("https://c.com");
  assert.ok(c);
  assert.equal(await st.resolve(c!), "https://c.com");
});

test("kv hits batched", async (t) => {
  if (skip || !st) return t.skip();
  await st.shorten("https://a.com", "h", 0);
  for (let i = 0; i < 5; i++) await st.resolve("h");
  await st.flush();
  await new Promise((r) => setTimeout(r, 20));
  const s = await st.stats("h");
  assert.equal(s?.hits, 5);
});

test("kv update/remove", async (t) => {
  if (skip || !st) return t.skip();
  await st.shorten("https://a.com", "u", 0);
  assert.equal(await st.update("u", "https://b.com"), "ok");
  assert.equal(await st.resolve("u"), "https://b.com");
  assert.equal(await st.update("missing", "https://x.com"), "missing");
  assert.equal(await st.remove("u"), "ok");
  assert.equal(await st.resolve("u"), null);
  assert.equal(await st.remove("u"), "missing");
});

test("kv ttl expiry", async (t) => {
  if (skip || !st) return t.skip();
  await st.shorten("https://t.com", "ttl", 80);
  assert.equal(await st.resolve("ttl"), "https://t.com");
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(await st.resolve("ttl"), null);
});

test("kv list/stats", async (t) => {
  if (skip || !st) return t.skip();
  await st.shorten("https://one.com", "one", 0);
  await st.shorten("https://two.com", "two", 0);
  await st.resolve("one");
  await st.flush();
  await new Promise((r) => setTimeout(r, 20));
  const { links, total } = await st.list(10, 0, "created");
  assert.ok(total >= 2);
  assert.ok(links.some((l) => l.code === "one" && l.hits >= 1));
  const s = await st.stats("two");
  assert.equal(s?.url, "https://two.com");
  assert.ok(s!.created_at > 0);
});

test("kv bulk", async (t) => {
  if (skip || !st) return t.skip();
  const urls = Array.from({ length: 50 }, (_, i) => `https://b.com/${i}`);
  const codes = await st.shortenMany(urls, 0);
  assert.equal(codes.length, 50);
  for (let i = 0; i < 50; i++)
    assert.equal(await st.resolve(codes[i]), urls[i]);
});

test("kv cold miss survives new handle", async (t) => {
  if (skip || !st || !ADDR) return t.skip();
  await st.shorten("https://stay.com", "stay", 0);
  const s2 = await KvStore.open(ADDR, 1, 100, 50);
  try {
    assert.equal(await s2.resolve("stay"), "https://stay.com");
  } finally {
    s2.close();
  }
});

test("kv cache bounded", async (t) => {
  if (skip || !st) return t.skip();
  const codes: string[] = [];
  for (let i = 0; i < 200; i++) {
    const c = await st.shorten(`https://x.com/${i}`);
    assert.ok(c);
    codes.push(c!);
  }
  for (const c of codes) assert.ok(await st.resolve(c), `cold miss ${c}`);
});

test("kv legacy value decode (key layout)", async (t) => {
  if (skip || !st) return t.skip();
  if (process.env.KV_LAYOUT === "hash") return t.skip("key layout only");
  const kv = await Kv.connect(ADDR!, 1);
  try {
    await kv.set("l:legacy1", "0|https://one.example", 0, false);
    await kv.set("l:legacy2", "0|0|https://two.example", 0, false);
    assert.equal(await st.resolve("legacy1"), "https://one.example");
    assert.equal(await st.resolve("legacy2"), "https://two.example");
    await st.shorten("https://v1.example", "v1check", 0);
    const raw = await kv.get("l:v1check");
    assert.ok(raw && raw.toString().startsWith("v1|"), `v1 tag: ${raw}`);
  } finally {
    kv.close();
  }
});
