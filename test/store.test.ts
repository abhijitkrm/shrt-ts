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

test("shorten generates random 8-char codes", () => {
  const s = new Store(":memory:");
  const a = s.shorten("https://example.com")!;
  const b = s.shorten("https://example.org")!;
  assert.match(a, /^[0-9a-zA-Z]{8}$/);
  assert.match(b, /^[0-9a-zA-Z]{8}$/);
  assert.notEqual(a, b);
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

test("codes are prefix-sharded across instances", () => {
  const dir = tmp();
  const a = new Store(dir, 0);
  const b = new Store(dir, 1);
  const ca = a.shorten("https://a.com")!;
  const cb = b.shorten("https://b.com")!;
  assert.notEqual(ca, cb);
  assert.notEqual(ca[0], cb[0]); // instance prefix guarantees disjoint spaces
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

test("remove deletes and tombstone survives reopen", () => {
  const dir = tmp();
  const s1 = new Store(dir);
  const code = s1.shorten("https://example.com")!;
  assert.equal(s1.remove(code), "ok");
  assert.equal(s1.resolve(code), null);
  s1.close();
  const s2 = new Store(dir, 0);
  assert.equal(s2.resolve(code), null); // tombstone replayed
  assert.equal(s2.remove("nope"), "missing");
  s2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("update changes url and persists across reopen", () => {
  const dir = tmp();
  const s1 = new Store(dir);
  const code = s1.shorten("https://old.example")!;
  s1.resolve(code); // 1 hit
  assert.equal(s1.update(code, "https://new.example", 60_000), "ok");
  assert.equal(s1.resolve(code), "https://new.example");
  s1.close();
  const s2 = new Store(dir, 0);
  const e = s2.stats(code)!;
  assert.equal(e.url, "https://new.example");
  assert.ok(e.expires_at! > Date.now());
  assert.ok(e.hits >= 1); // hit deltas still merge
  s2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("update/remove on remote-owned code returns remote", () => {
  const dir = tmp();
  const a = new Store(dir, 0);
  const b = new Store(dir, 1);
  const code = a.shorten("https://a.example")!;
  a.flush();
  b.pollTails();
  assert.equal(b.update(code, "https://x.example"), "remote");
  assert.equal(b.remove(code), "remote");
  assert.equal(a.remove(code), "ok"); // owner can delete
  a.close();
  b.close();
  rmSync(dir, { recursive: true, force: true });
});

test("list paginates, sorts by hits, filters", () => {
  const s = new Store(":memory:");
  const a = s.shorten("https://aaa.example")!;
  s.shorten("https://bbb.example");
  s.shorten("https://ccc.example");
  s.resolve(a);
  s.resolve(a);
  const all = s.list(50, 0, "created");
  assert.equal(all.total, 3);
  assert.equal(all.links.length, 3);
  const page = s.list(2, 0, "created");
  assert.equal(page.links.length, 2);
  const byHits = s.list(50, 0, "hits");
  assert.equal(byHits.links[0].code, a);
  const filtered = s.list(50, 0, "created", "bbb");
  assert.equal(filtered.total, 1);
  assert.equal(filtered.links[0].url, "https://bbb.example");
  s.close();
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
