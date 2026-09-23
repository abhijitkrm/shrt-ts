// kvstore.ts — external-KV backend (DragonflyDB / Redis / any RESP server).
// The corpus lives in the KV store; this process keeps only a bounded hot
// FIFO cache + batched hit counters — memory stays flat as links grow.
//
// Keys:  l:{code} -> "{expires_ms}|{created_ms}|{url}"  (PX self-evicts)
//        h:{code} -> hit counter (INCRBY, flushed in 5ms batches)
//
// Multi-instance: the KV IS the shared state — no tailing, no convergence,
// admin mutations work on any node.

import { Kv, type Resp } from "./kv.js";
import type { Link } from "./store.js";
import type { MutRes, StoreApi } from "./storeapi.js";
import { ALPHABET } from "./base62.js";
import { randomInt } from "node:crypto";

const FLUSH_MS = 5;
const SHARDS = 64;

type CacheEntry = { u: string; e: number; at: number };
type CacheShard = { m: Map<string, CacheEntry>; order: string[]; head: number };

const TRACK_HITS = process.env.HITS !== "0";

export class KvStore implements StoreApi {
  private kv: Kv;
  private instance: number;
  private prefix: string;
  private capPerShard: number;
  private cacheTtlMs: number;
  private cache: CacheShard[] = [];
  private dirty: Map<string, number>[] = [];
  private timer: NodeJS.Timeout;
  private janitor: NodeJS.Timeout | null = null;
  private layoutHash: boolean;
  private buckets: number;
  private closed = false;

  private constructor(kv: Kv, instance: number, cacheEntries: number, cacheTtlMs: number) {
    this.kv = kv;
    this.instance = Math.max(0, Math.min(61, instance));
    this.prefix = ALPHABET[this.instance];
    this.capPerShard = Math.max(16, Math.floor(cacheEntries / SHARDS));
    this.cacheTtlMs = cacheTtlMs;
    for (let i = 0; i < SHARDS; i++) {
      this.cache.push({ m: new Map(), order: [], head: 0 });
      this.dirty.push(new Map());
    }
    this.layoutHash = process.env.KV_LAYOUT === "hash";
    this.buckets = Math.max(1, Number(process.env.KV_BUCKETS ?? 1_000_000) || 1_000_000);
    this.timer = setInterval(() => {
      this.flushHits().catch(() => {});
    }, FLUSH_MS);
    this.timer.unref();
    if (this.layoutHash) {
      const sweepMs = Math.max(50, Number(process.env.KV_SWEEP_MS ?? 3_600_000) || 3_600_000);
      this.janitor = setInterval(() => {
        this.sweepExpired().catch(() => {});
      }, sweepMs);
      this.janitor.unref();
    }
  }

  static async open(
    addr: string,
    instance: number,
    cacheEntries: number,
    cacheTtlMs: number
  ): Promise<KvStore> {
    const kv = await Kv.connect(addr, 8);
    return new KvStore(kv, instance, cacheEntries, cacheTtlMs);
  }

  private shard(code: string): number {
    let h = 2166136261;
    for (let i = 0; i < code.length; i++) {
      h ^= code.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) & (SHARDS - 1);
  }

  private lkey(c: string): string { return `l:${c}`; }
  private hkey(c: string): string { return `h:${c}`; }
  private bkey(c: string): string { return `l:${this.shard(c) % this.buckets}`; }
  private hfield(c: string): string { return `h:${c}`; }

  private async kvGet(code: string): Promise<Buffer | null> {
    return this.layoutHash ? this.kv.hget(this.bkey(code), code) : this.kv.get(this.lkey(code));
  }

  // janitor: HDEL fields past expiry (hash fields can't carry PX)
  private async sweepExpired(): Promise<void> {
    const buckets: string[] = [];
    await this.kv.scanEach("l:*", (k) => buckets.push(k));
    const now = Date.now();
    const dels: string[][] = [];
    for (const b of buckets) {
      const dead: string[] = [];
      await this.kv.hscanEach(b, (f, v) => {
        if (f.startsWith("h:")) return;
        const d = this.dec(v);
        if (d && d.e !== 0 && d.e <= now) dead.push(f);
      });
      for (const f of dead) dels.push(["HDEL", b, f]);
    }
    if (dels.length) await this.kv.pipe(dels);
  }

  // "{e}|{c}|{u}" — legacy "{e}|{u}" decodes with c=0
  private enc(e: number, c: number, u: string): string {
    return `${e}|${c}|${u}`;
  }
  private dec(v: string): { e: number; c: number; u: string } | null {
    const p = v.indexOf("|");
    if (p < 0) return null;
    const e = Number(v.slice(0, p));
    if (!Number.isFinite(e)) return null;
    const rest = v.slice(p + 1);
    const q = rest.indexOf("|");
    if (q >= 0) {
      const c = Number(rest.slice(0, q));
      if (!Number.isFinite(c)) return null;
      return { e, c, u: rest.slice(q + 1) };
    }
    return { e, c: 0, u: rest };
  }

  private async flushHits(): Promise<void> {
    if (this.layoutHash) {
      const deltas: [string, string, number][] = [];
      for (const d of this.dirty) {
        for (const [code, n] of d) deltas.push([this.bkey(code), this.hfield(code), n]);
        d.clear();
      }
      await this.kv.hincrbyMany(deltas);
      return;
    }
    const deltas: [string, number][] = [];
    for (const d of this.dirty) {
      for (const [code, n] of d) deltas.push([this.hkey(code), n]);
      d.clear();
    }
    await this.kv.incrbyMany(deltas);
  }

  private bump(code: string): void {
    if (!TRACK_HITS) return;
    const d = this.dirty[this.shard(code)];
    d.set(code, (d.get(code) ?? 0) + 1);
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
    if (sh.m.has(code)) {
      sh.m.set(code, { u, e, at: Date.now() });
      return;
    }
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
    let c = this.prefix;
    for (let i = 1; i < 8; i++) c += ALPHABET[randomInt(62)];
    return c;
  }

  async resolve(code: string): Promise<string | null> {
    const hit = this.cacheGet(code);
    if (hit) {
      this.bump(code);
      return hit.u;
    }
    let v: Buffer | null;
    try {
      v = await this.kvGet(code);
    } catch {
      return null;
    }
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
    try {
      if (alias !== undefined) {
        const ok = this.layoutHash
          ? await this.kv.hsetnx(this.bkey(alias), alias, this.enc(exp, now, url))
          : await this.kv.set(this.lkey(alias), this.enc(exp, now, url), ttlMs, true);
        return ok ? alias : null;
      }
      for (;;) {
        const c = this.genCode();
        const ok = this.layoutHash
          ? await this.kv.hsetnx(this.bkey(c), c, this.enc(exp, now, url))
          : await this.kv.set(this.lkey(c), this.enc(exp, now, url), ttlMs, true);
        if (ok) return c;
      }
    } catch {
      return null;
    }
  }

  async shortenMany(urls: string[], ttlMs = 0): Promise<string[]> {
    const now = Date.now();
    const exp = ttlMs > 0 ? now + ttlMs : 0;
    const codes = urls.map(() => this.genCode());
    const cmds = urls.map((u, i) => {
      if (this.layoutHash)
        return ["HSETNX", this.bkey(codes[i]), codes[i], this.enc(exp, now, u)];
      const a = ["SET", this.lkey(codes[i]), this.enc(exp, now, u)];
      if (ttlMs > 0) a.push("PX", String(ttlMs));
      a.push("NX");
      return a;
    });
    let rs: Resp[];
    try {
      rs = await this.kv.pipe(cmds);
    } catch {
      rs = [];
    }
    for (let i = 0; i < urls.length; i++) {
      const r = rs[i];
      const ok = this.layoutHash
        ? r && r.kind === "int" && r.num === 1
        : r && r.kind === "simple" && r.str === "OK";
      if (!ok) {
        const c2 = await this.shorten(urls[i], undefined, ttlMs);
        if (c2) codes[i] = c2;
      }
    }
    return codes;
  }

  async update(code: string, url: string, ttlMs?: number): Promise<MutRes> {
    let v: Buffer | null;
    try {
      v = await this.kvGet(code);
    } catch {
      return "missing";
    }
    if (!v) return "missing";
    const d = this.dec(v.toString());
    if (!d) return "missing";
    const exp = ttlMs === undefined ? d.e : ttlMs > 0 ? Date.now() + ttlMs : 0;
    const px = exp > 0 ? exp - Date.now() : 0;
    try {
      const ok = this.layoutHash
        ? (await this.kv.hset(this.bkey(code), code, this.enc(exp, d.c, url)), true)
        : await this.kv.set(this.lkey(code), this.enc(exp, d.c, url), px, false);
      if (!ok) return "missing";
    } catch {
      return "missing";
    }
    this.cacheDel(code);
    return "ok";
  }

  async remove(code: string): Promise<MutRes> {
    let n: number;
    try {
      n = this.layoutHash
        ? await this.kv.hdel(this.bkey(code), code)
        : await this.kv.del(this.lkey(code));
    } catch {
      return "missing";
    }
    if (n <= 0) return "missing";
    if (this.layoutHash) await this.kv.hdel(this.bkey(code), this.hfield(code)).catch(() => {});
    else await this.kv.del(this.hkey(code)).catch(() => {});
    this.cacheDel(code);
    return "ok";
  }

  async list(
    limit: number,
    offset: number,
    sort: "created" | "hits",
    q?: string
  ): Promise<{ links: Link[]; total: number }> {
    const items: Link[] = [];
    if (this.layoutHash) {
      const now = Date.now();
      const fields: [string, string][] = [];
      const buckets: string[] = [];
      try {
        await this.kv.scanEach("l:*", (k) => buckets.push(k));
        for (const b of buckets)
          await this.kv.hscanEach(b, (f, v) => {
            if (!f.startsWith("h:")) fields.push([f, v]);
          });
      } catch {
        return { links: [], total: 0 };
      }
      const hcmds = fields.map(([f]) => ["HGET", this.bkey(f), this.hfield(f)]);
      let hrs: Resp[] = [];
      try { hrs = await this.kv.pipe(hcmds); } catch {}
      for (let i = 0; i < fields.length; i++) {
        const [code, val] = fields[i];
        const d = this.dec(val);
        if (!d || (d.e !== 0 && d.e <= now)) continue;
        if (q && !code.includes(q) && !d.u.includes(q)) continue;
        const rh = hrs[i];
        const hits = rh && rh.kind === "bulk" && rh.str ? Number(rh.str.toString()) || 0 : 0;
        items.push({ code, url: d.u, hits, created_at: d.c, expires_at: d.e !== 0 ? d.e : null });
      }
      items.sort(sort === "hits" ? (x, y) => y.hits - x.hits : (x, y) => y.created_at - x.created_at);
      return { links: items.slice(offset, offset + limit), total: items.length };
    }
    const keys: string[] = [];
    try {
      await this.kv.scanEach("l:*", (k) => keys.push(k));
    } catch {
      return { links: [], total: 0 };
    }
    const cmds = keys.flatMap((k) => [
      ["GET", k],
      ["GET", this.hkey(k.slice(2))],
    ]);
    let rs: Resp[];
    try {
      rs = await this.kv.pipe(cmds);
    } catch {
      rs = [];
    }
    for (let i = 0; i < keys.length; i++) {
      const code = keys[i].slice(2);
      const rv = rs[2 * i];
      if (!rv || rv.kind !== "bulk" || !rv.str) continue;
      const d = this.dec(rv.str.toString());
      if (!d) continue;
      if (q && !code.includes(q) && !d.u.includes(q)) continue;
      const rh = rs[2 * i + 1];
      const hits =
        rh && rh.kind === "bulk" && rh.str ? Number(rh.str.toString()) || 0 : 0;
      items.push({
        code,
        url: d.u,
        hits,
        created_at: d.c,
        expires_at: d.e !== 0 ? d.e : null,
      });
    }
    items.sort(
      sort === "hits"
        ? (x, y) => y.hits - x.hits
        : (x, y) => y.created_at - x.created_at
    );
    return { links: items.slice(offset, offset + limit), total: items.length };
  }

  async stats(code: string): Promise<Link | null> {
    let v: Buffer | null;
    try {
      v = await this.kvGet(code);
    } catch {
      return null;
    }
    if (!v) return null;
    const d = this.dec(v.toString());
    if (!d) return null;
    let hits = 0;
    try {
      const hv = this.layoutHash
        ? await this.kv.hget(this.bkey(code), this.hfield(code))
        : await this.kv.get(this.hkey(code));
      if (hv) hits = Number(hv.toString()) || 0;
    } catch {}
    hits += this.dirty[this.shard(code)].get(code) ?? 0;
    return {
      code,
      url: d.u,
      hits,
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
    if (this.layoutHash) {
      let any = false;
      try {
        const buckets: string[] = [];
        await this.kv.scanEach("l:*", (k) => buckets.push(k));
        for (const b of buckets) {
          await this.kv.hscanEach(b, (f) => {
            if (!f.startsWith("h:")) any = true;
          });
          if (any) return false;
        }
      } catch {
        return true;
      }
      return true;
    }
    let any = false;
    try {
      await this.kv.scanEach("l:*", () => {
        any = true;
      });
    } catch {
      return true;
    }
    return !any;
  }

  flush(): void {
    this.flushHits().catch(() => {});
  }
  pollTails(): void {}
  compact(): void {}
  close(): void {
    if (this.closed) return;
    if (this.janitor) clearInterval(this.janitor);
    this.closed = true;
    clearInterval(this.timer);
    this.kv.close();
  }
}
