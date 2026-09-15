import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { encode } from "../src/base62.js";

const tmp = () => mkdtempSync(join(tmpdir(), "store-"));

test("base62 encode", () => {
  assert.equal(encode(0), "0");
  assert.equal(encode(1), "1");
  assert.equal(encode(61), "Z");
  assert.equal(encode(62), "10");
  assert.equal(encode(3843), "ZZ");
});

test("shorten generates short codes", () => {
  const s = new Store(":memory:");
  assert.equal(s.shorten("https://example.com"), "1");
  assert.equal(s.shorten("https://example.org"), "2");
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
  const gen = s.shorten("https://c.com");
  assert.notEqual(gen, "my-link");
  assert.equal(s.resolve(gen!), "https://c.com");
  s.close();
});

test("expired links stop resolving", () => {
  const s = new Store(":memory:");
  const code = s.shorten("https://example.com", undefined, 5)!;
  assert.equal(s.resolve(code), "https://example.com");
  const e = (s as any).data.get(code);
  e.e = Date.now() - 1; // simulate passage of time
  assert.equal(s.resolve(code), null);
  s.close();
});

test("shortenMany returns aligned codes", () => {
  const s = new Store(":memory:");
  const urls = ["https://a.com", "https://b.com", "https://c.com"];
  const codes = s.shortenMany(urls);
  assert.equal(codes.length, 3);
  assert.equal(new Set(codes).size, 3);
  for (let i = 0; i < 3; i++) assert.equal(s.resolve(codes[i]), urls[i]);
  s.close();
});

test("data persists across reopen (rows + hits)", () => {
  const dir = tmp();
  const s1 = new Store(dir);
  const code = s1.shorten("https://example.com")!;
  s1.resolve(code);
  s1.resolve(code);
  s1.close();
  const s2 = new Store(dir, 0); // same instance replays own log
  assert.equal(s2.resolve(code), "https://example.com");
  assert.equal(s2.stats(code)!.hits, 3);
  s2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("codes stay unique across instances", () => {
  const dir = tmp();
  const a = new Store(dir, 0);
  const b = new Store(dir, 1);
  const ca = a.shorten("https://a.com")!;
  const cb = b.shorten("https://b.com")!;
  assert.notEqual(ca, cb);
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("sibling log tailing converges rows", () => {
  const dir = tmp();
  const a = new Store(dir, 0);
  const b = new Store(dir, 1);
  const code = a.shorten("https://a.com")!;
  a.flush();
  b.pollTails();
  assert.equal(b.resolve(code), "https://a.com");
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("sibling sees hits via tail", () => {
  const dir = tmp();
  const a = new Store(dir, 0);
  const b = new Store(dir, 1);
  const code = a.shorten("https://a.com")!;
  a.flush();
  b.pollTails();
  a.resolve(code);
  a.resolve(code);
  a.flush();
  b.pollTails();
  assert.equal(b.stats(code)!.hits, 2);
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("compact snapshot preserves rows and truncates log", () => {
  const dir = tmp();
  const s = new Store(dir, 0);
  const code = s.shorten("https://example.com")!;
  s.resolve(code);
  s.compact();
  s.close();
  const s2 = new Store(dir, 0);
  assert.equal(s2.resolve(code), "https://example.com");
  assert.equal(s2.stats(code)!.hits, 2); // reopen hit counts once more
  s2.close();
  rmSync(dir, { recursive: true, force: true });
});
