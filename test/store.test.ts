import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { encode } from "../src/base62.js";

test("base62 encode", () => {
  assert.equal(encode(0), "0");
  assert.equal(encode(1), "1");
  assert.equal(encode(61), "Z");
  assert.equal(encode(62), "10");
  assert.equal(encode(3843), "ZZ");
});

test("shorten generates short codes", () => {
  const s = new Store(":memory:");
  const c1 = s.shorten("https://example.com");
  const c2 = s.shorten("https://example.org");
  assert.equal(c1, "1");
  assert.equal(c2, "2");
  s.close();
});

test("resolve returns url and counts hits", () => {
  const s = new Store(":memory:");
  const code = s.shorten("https://example.com")!;
  assert.equal(s.resolve(code), "https://example.com");
  assert.equal(s.resolve(code), "https://example.com");
  const stats = s.stats(code)!;
  assert.equal(stats.hits, 2);
  assert.equal(stats.url, "https://example.com");
  s.close();
});

test("resolve misses unknown code", () => {
  const s = new Store(":memory:");
  assert.equal(s.resolve("nope"), null);
  assert.equal(s.stats("nope"), null);
  s.close();
});

test("custom alias works and collision returns null", () => {
  const s = new Store(":memory:");
  assert.equal(s.shorten("https://a.com", "my-link"), "my-link");
  assert.equal(s.resolve("my-link"), "https://a.com");
  assert.equal(s.shorten("https://b.com", "my-link"), null);
  // generated codes must not collide with alias ids
  const gen = s.shorten("https://c.com");
  assert.notEqual(gen, "my-link");
  assert.equal(s.resolve(gen!), "https://c.com");
  s.close();
});

test("expired links stop resolving", () => {
  const s = new Store(":memory:");
  const code = s.shorten("https://example.com", undefined, 5)!;
  assert.equal(s.resolve(code), "https://example.com");
  const entry = (s as any).cache.get(code);
  entry.exp = Date.now() - 1; // simulate passage of time
  assert.equal(s.resolve(code), null);
  s.close();
});

test("hits flush to sqlite", () => {
  const s = new Store(":memory:");
  const code = s.shorten("https://example.com")!;
  s.resolve(code);
  s.resolve(code);
  s.resolve(code);
  s.flushHits();
  const row = (s as any).stmtStats.get(code);
  assert.equal(row.hits, 3);
  s.close();
});

test("cache is bounded (FIFO eviction)", () => {
  const s = new Store(":memory:", 3);
  s.shorten("https://a.com", "a1");
  s.shorten("https://b.com", "a2");
  s.shorten("https://c.com", "a3");
  s.shorten("https://d.com", "a4");
  assert.equal((s as any).cache.size, 3);
  assert.equal((s as any).cache.has("a1"), false);
  assert.equal(s.resolve("a1"), "https://a.com"); // still resolves from db
  s.close();
});
