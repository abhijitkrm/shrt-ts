// rocksstore.ts — embedded RocksDB backend (STORE=rocksdb).
//
// Keys: l:{code} -> "{expires_ms}|{created_ms}|{url}"
//       h:{code} -> u64 hit counter
// The level-style rocksdb binding exposes no merge operator, but the
// store is single-writer (RocksDB LOCKs the dir), so flushed counters are
// written as absolute values — local dirty map + persisted base is
// authoritative. Expiry is embedded in the value and enforced on read; a
// sweep (ROCKSDB_SWEEP_MS, default 1h) deletes expired keys. Reads go
// through a bounded hot FIFO so the DB only sees cache misses.
//
// Embedded means single-writer: one process per ROCKSDB_PATH. For
// multi-instance/multi-node use the RESP KV backend.

import rocksdb from "rocksdb";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Link } from "./store.js";
import type { MutRes, StoreApi } from "./storeapi.js";

const SHARDS = 256;
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TRACK_HITS = process.env.HITS !== "0";
const FLUSH_MS = 5;

type CacheEntry = { u: string; e: number; at: number };
type CacheShard = { m: Map<string, CacheEntry>; order: string[]; head: number };

// promisified binding helpers (leveldown-style callbacks)
function pget(db: any, k: string): Promise<Buffer | null> {
  return new Promise((res, rej) =>
    db.get(k, (e: Error | null, v?: Buffer) =>
      e ? (e.message.startsWith("NotFound") ? res(null) : rej(e)) : res(v ?? null)
    )
  );
}
function pbatch(db: any, ops: { type: string; key: string; value?: string | Buffer }[]): Promise<void> {
  return new Promise((res, rej) => {
    const b = db.batch();
    for (const o of ops) o.type === "del" ? b.del(o.key) : b.put(o.key, o.value);
    b.write((e: Error | null) => (e ? rej(e) : res()));
  });
}
function peach(db: any, lo: string, hi: string, cb: (k: string, v: string) => void): Promise<void> {
  return new Promise((res, rej) => {
    const it = db.iterator({ gte: lo, lt: hi });
    const next = () =>
      it.next((e: Error | null, k?: Buffer, v?: Buffer) => {
        if (e) { it.end(() => rej(e)); return; }
        if (k === undefined) { it.end(() => res()); return; }
        cb(k.toString(), v ? v.toString() : "");
        next();
      });
    next();
  });
}

export class RocksStore implements StoreApi {
  private db: any;
  private instance: number;
  private prefix: string;
  private capPerShard: number;
  private cacheTtlMs: number;
  private cache: CacheShard[] = [];
  private dirty: Map<string, number>[] = [];
  private timer: NodeJS.Timeout;
  private sweeper: NodeJS.Timeout | null = null;
  private closed = false;

  private constructor(db: any, instance: number, cacheEntries: number, cacheTtlMs: number) {
    this.db = db;
    this.instance = Math.max(0, Math.min(61, instance));
    this.prefix = ALPHABET[this.instance];
    this.cacheTtlMs = cacheTtlMs;
    this.capPerShard = Math.max(16, Math.floor(cacheEntries / SHARDS));
    for (let i = 0; i < SHARDS; i++) {
      this.cache.push({ m: new Map(), order: [], head: 0 });
      this.dirty.push(new Map());
    }
    this.timer = setInterval(() => {
      this.flushHits().catch(() => {});
    }, FLUSH_MS);
    this.timer.unref();
    const sweepMs = Math.max(50, Number(process.env.ROCKSDB_SWEEP_MS ?? 3_600_000) || 3_600_000);
    this.sweeper = setInterval(() => {
      this.sweepExpired().catch(() => {});
    }, sweepMs);
    this.sweeper.unref();
  }

  static async open(
    path: string,
    instance: number,
    cacheEntries: number,
    cacheTtlMs: number
  ): Promise<RocksStore> {
    mkdirSync(path, { recursive: true });
    const db = rocksdb(path);
    await new Promise<void>((res, rej) =>
      db.open((e: Error | null) => (e ? rej(e) : res()))
    );
    return new RocksStore(db, instance, cacheEntries, cacheTtlMs);
  }

  private lkey(c: string): string { return `l:${c}`; }
  private hkey(c: string): string { return `h:${c}`; }

  private enc(e: number, c: number, u: string): string { return `${e}|${c}|${u}`; }
  private dec(v: string): { e: number; c: number; u: string } | null {
    const p = v.indexOf("|");
    if (p < 0) return null;
    const e = Number(v.slice(0, p));
    if (!Number.isFinite(e)) return null;
    const rest = v.slice(p + 1);
    const q = rest.indexOf("|");
    if (q < 0) return { e, c: 0, u: rest };
    const c = Number(rest.slice(0, q));
    if (!Number.isFinite(c)) return null;
    return { e, c, u: rest.slice(q + 1) };
  }

  private shard(code: string): number {
    let h = 2166136261;
    for (let i = 0; i < code.length; i++) {
      h ^= code.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) & (SHARDS - 1);
  }

  private bump(code: string): void {
    if (!TRACK_HITS) return;
    const d = this.dirty[this.shard(code)];
    d.set(code, (d.get(code) ?? 0) + 1);
  }

  // single-writer: persisted value + local delta is authoritative
  private async flushHits(): Promise<void> {
    const ops: { type: string; key: string; value: Buffer }[] = [];
    for (const d of this.dirty) {
      for (const [code, n] of d) {
        const base = await pget(this.db, this.hkey(code));
        const prev = base && base.length >= 8 ? Number(base.readBigUInt64LE(0)) : 0;
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(prev + n));
        ops.push({ type: "put", key: this.hkey(code), value: b });
      }
      d.clear();
    }
    if (ops.length) await pbatch(this.db, ops);
  }

  private async sweepExpired(): Promise<void> {
    const now = Date.now();
    const dead: string[] = [];
    await peach(this.db, "l:", "l;", (k, v) => {
      const d = this.dec(v);
      if (d && d.e !== 0 && d.e <= now) dead.push(k);
    });
    if (dead.length)
      await pbatch(this.db, dead.map((k) => ({ type: "del", key: k })));
  }

  private cacheGet(code: string): { u: string; e: number } | null {
    const sh = this.cache[this.shard(code)];
    const e = sh.m.get(code);
    if (!e) return null;
    const now = Date.now();
    if (this.cacheTtlMs > 0 && now - e.at > this.cacheTtlMs) {
      sh.m.delete(code);
      return null;
    }
    if (e.e !== 0 && e.e <= now) return null;
    return e;
  }
  private cachePut(code: string, u: string, e: number): void {
    const sh = this.cache[this.shard(code)];
    const cur = sh.m.get(code);
    if (cur) { cur.u = u; cur.e = e; cur.at = Date.now(); return; }
    while (sh.m.size >= this.capPerShard && sh.head < sh.order.length) {
      sh.m.delete(sh.order[sh.head++]);
    }
    if (sh.head > 1024 && sh.head * 2 >= sh.order.length) {
      sh.order = sh.order.slice(sh.head);
      sh.head = 0;
    }
    sh.order.push(code);
    sh.m.set(code, { u, e, at: Date.now() });
  }
  private cacheDel(code: string): void {
    this.cache[this.shard(code)].m.delete(code);
  }

  private genCode(): string {
    const c = new Array(8);
    c[0] = this.prefix;
    const r = randomBytes(7);
    for (let i = 1; i < 8; i++) c[i] = ALPHABET[r[i - 1] % 62];
    return c.join("");
  }

  private async linkHits(code: string): Promise<number> {
    const v = await pget(this.db, this.hkey(code)).catch(() => null);
    let h = v && v.length >= 8 ? Number(v.readBigUInt64LE(0)) : 0;
    h += this.dirty[this.shard(code)].get(code) ?? 0;
    return h;
  }

  async resolve(code: string): Promise<string | null> {
    const ce = this.cacheGet(code);
    if (ce) { this.bump(code); return ce.u; }
    const v = await pget(this.db, this.lkey(code)).catch(() => null);
    if (!v) return null;
    const d = this.dec(v.toString());
    if (!d || (d.e !== 0 && d.e <= Date.now())) return null;
    this.cachePut(code, d.u, d.e);
    this.bump(code);
    return d.u;
  }

  async shorten(url: string, alias?: string, ttlMs = 0): Promise<string | null> {
    const now = Date.now();
    const exp = ttlMs > 0 ? now + ttlMs : 0;
    const put = async (code: string): Promise<boolean> => {
      if (await pget(this.db, this.lkey(code)).catch(() => null)) return false;
      await pbatch(this.db, [{ type: "put", key: this.lkey(code), value: this.enc(exp, now, url) }]);
      this.cachePut(code, url, exp);
      return true;
    };
    try {
      if (alias !== undefined) return (await put(alias)) ? alias : null;
      for (;;) {
        const c = this.genCode();
        if (await put(c)) return c;
      }
    } catch {
      return null;
    }
  }

  async shortenMany(urls: string[], ttlMs = 0): Promise<string[]> {
    const now = Date.now();
    const exp = ttlMs > 0 ? now + ttlMs : 0;
    const codes: (string | null)[] = urls.map(() => this.genCode());
    const ops: { type: string; key: string; value: string }[] = [];
    const retry: number[] = [];
    for (let i = 0; i < urls.length; i++) {
      if (await pget(this.db, this.lkey(codes[i]!)).catch(() => null)) {
        retry.push(i);
        continue;
      }
      ops.push({ type: "put", key: this.lkey(codes[i]!), value: this.enc(exp, now, urls[i]) });
    }
    try {
      await pbatch(this.db, ops);
      for (let i = 0; i < urls.length; i++)
        if (!retry.includes(i)) this.cachePut(codes[i]!, urls[i], exp);
    } catch {
      retry.length = 0;
      for (let i = 0; i < urls.length; i++) retry.push(i);
    }
    for (const i of retry) codes[i] = await this.shorten(urls[i], undefined, ttlMs);
    return codes.map((c) => c ?? "");
  }

  async update(code: string, url: string, ttlMs?: number): Promise<MutRes> {
    const v = await pget(this.db, this.lkey(code)).catch(() => null);
    if (!v) return "missing";
    const d = this.dec(v.toString());
    if (!d) return "missing";
    const exp = ttlMs === undefined ? d.e : ttlMs > 0 ? Date.now() + ttlMs : 0;
    try {
      await pbatch(this.db, [{ type: "put", key: this.lkey(code), value: this.enc(exp, d.c, url) }]);
    } catch {
      return "missing";
    }
    this.cacheDel(code);
    return "ok";
  }

  async remove(code: string): Promise<MutRes> {
    const v = await pget(this.db, this.lkey(code)).catch(() => null);
    if (!v) return "missing";
    try {
      await pbatch(this.db, [
        { type: "del", key: this.lkey(code) },
        { type: "del", key: this.hkey(code) },
      ]);
    } catch {
      return "missing";
    }
    this.cacheDel(code);
    return "ok";
  }

  async list(
    limit: number,
    offset: number,
    sort: "created" | "hits",
    q?: string
  ): Promise<{ links: Link[]; total: number }> {
    const now = Date.now();
    const fields: [string, string][] = [];
    try {
      await peach(this.db, "l:", "l;", (k, v) => fields.push([k.slice(2), v]));
    } catch {
      return { links: [], total: 0 };
    }
    const items: Link[] = [];
    for (const [code, val] of fields) {
      const d = this.dec(val);
      if (!d || (d.e !== 0 && d.e <= now)) continue;
      if (q && !code.includes(q) && !d.u.includes(q)) continue;
      items.push({
        code,
        url: d.u,
        hits: await this.linkHits(code),
        created_at: d.c,
        expires_at: d.e !== 0 ? d.e : null,
      });
    }
    items.sort(sort === "hits"
      ? (x, y) => y.hits - x.hits
      : (x, y) => y.created_at - x.created_at);
    return { links: items.slice(offset, offset + limit), total: items.length };
  }

  async stats(code: string): Promise<Link | null> {
    const v = await pget(this.db, this.lkey(code)).catch(() => null);
    if (!v) return null;
    const d = this.dec(v.toString());
    if (!d || (d.e !== 0 && d.e <= Date.now())) return null;
    return {
      code,
      url: d.u,
      hits: await this.linkHits(code),
      created_at: d.c,
      expires_at: d.e !== 0 ? d.e : null,
    };
  }

  async seed(urls: string[]): Promise<number> {
    await this.shortenMany(urls);
    await this.flushHits().catch(() => {});
    return urls.length;
  }

  async isEmpty(): Promise<boolean> {
    let any = false;
    try {
      await peach(this.db, "l:", "l;", () => { any = true; });
    } catch {
      return true;
    }
    return !any;
  }

  flush(): Promise<void> { return this.flushHits().catch(() => {}); }
  pollTails(): void {}
  compact(): void { this.db.compactRange?.("l:", "l;", () => {}); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (this.sweeper) clearInterval(this.sweeper);
    this.flushHits().catch(() => {}).finally(() => this.db.close(() => {}));
  }
}
