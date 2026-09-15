import { join } from "node:path";
import { writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import {
  Aof,
  replayFile,
  TailReader,
  claimInstance,
  shardFiles,
} from "./aof.js";
import { ALPHABET } from "./base62.js";

export interface Link {
  code: string;
  url: string;
  hits: number;
  created_at: number;
  expires_at: number | null;
}

interface Entry {
  u: string;
  a: number;
  e: number | null;
  h: number; // total hits (own + remote deltas seen)
  oh: number; // own hits only (what snapshots persist)
  i: number;
}

const FLUSH_MS = 5;
const FSYNC_MS = 500;
const TAIL_MS = Number(process.env.TAIL_MS ?? 0); // 0 = lazy on-miss only
const TAIL_MIN_INTERVAL = 200;
const FLUSH_BYTES = 256 << 10;
const CODE_LEN = 8; // 1 instance-prefix char + 7 random base62 chars
const MAX_INSTANCES = ALPHABET.length; // prefix char space
const MAX_STRAY_HITS = 10_000;
const TRACK_HITS = process.env.HITS !== "0";

const noop = () => {};

/** Escaped url for inline log serialization (quotes/backslashes/newlines). */
const esc = (u: string) => JSON.stringify(u).slice(1, -1);

const rowLine = (
  c: string,
  eu: string,
  a: number,
  e: number | null,
  i: number,
  n = 0
) => `{"c":"${c}","u":"${eu}","a":${a},"e":${e},"i":${i},"n":${n}}`;

/**
 * In-memory KV + append-only-log persistence.
 * - reads: pure Map.get (no disk, no SQL)
 * - writes: map.set + buffered append; fsync batch every FLUSH_MS (<=5ms loss window)
 * - multi-instance: per-instance log shards (data-<i>.log). Generated codes
 *   are 8 chars: ALPHABET[instance] + 7 random base62 chars — the prefix
 *   keeps codes unique across instances with zero coordination and lets a
 *   read-miss tail exactly the owning shard's log.
 */
export class Store {
  private data = new Map<string, Entry>();
  private pendingHits = new Map<string, number>();
  private strayHits = new Map<string, { t: number; o: number }>();
  private aof: Aof | null = null;
  private instance = 0;
  private prefix = ALPHABET[0];
  private release: () => void = noop;
  private dir = "";
  private ownName = "";
  private tails = new Map<string, TailReader>();
  private flushTimer: NodeJS.Timeout;
  private syncTimer: NodeJS.Timeout | null = null;
  private tailTimer: NodeJS.Timeout | null = null;

  constructor(dir: string, instance?: number) {
    if (dir !== ":memory:") {
      const claim =
        instance !== undefined
          ? { id: instance, release: noop }
          : claimInstance(dir);
      this.instance = claim.id;
      if (this.instance >= MAX_INSTANCES) {
        throw new Error(`instance ${this.instance} >= max ${MAX_INSTANCES}`);
      }
      this.prefix = ALPHABET[this.instance];
      this.release = claim.release;
      this.dir = dir;
      this.ownName = `data-${this.instance}.log`;
      this.aof = new Aof(dir, this.ownName);
      this.loadAll();
      if (TAIL_MS > 0) {
        this.tailTimer = setInterval(() => this.pollTails(), TAIL_MS);
        this.tailTimer.unref();
      }
      this.syncTimer = setInterval(() => this.aof?.sync(), FSYNC_MS);
      this.syncTimer.unref();
    }
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.flushTimer.unref();
  }

  private apply(o: {
    c?: string;
    u?: string;
    a?: number;
    e?: number | null;
    i?: number;
    n?: number;
    h?: string;
    d?: number;
    x?: string;
  }): void {
    if (o.x !== undefined) {
      this.data.delete(o.x);
      this.strayHits.delete(o.x);
      return;
    }
    if (o.h !== undefined) {
      const d = o.d ?? 0;
      const own = o.i === this.instance;
      const e = this.data.get(o.h);
      if (e) {
        e.h += d;
        if (own) e.oh += d;
      } else {
        if (this.strayHits.size >= MAX_STRAY_HITS) {
          const k = this.strayHits.keys().next().value;
          if (k !== undefined) this.strayHits.delete(k);
        }
        const s = this.strayHits.get(o.h) ?? { t: 0, o: 0 };
        s.t += d;
        if (own) s.o += d;
        this.strayHits.set(o.h, s);
      }
      return;
    }
    if (o.c === undefined || o.u === undefined) return;
    const stray = this.strayHits.get(o.c) ?? { t: 0, o: 0 };
    const entry: Entry = {
      u: o.u,
      a: o.a ?? 0,
      e: o.e ?? null,
      h: (o.n ?? 0) + stray.t,
      oh: (o.n ?? 0) + stray.o,
      i: o.i ?? -1,
    };
    this.strayHits.delete(o.c);
    this.data.set(o.c, entry);
  }

  /** Replay snapshot + own log + all sibling logs present at boot. */
  private loadAll(): void {
    replayFile(join(this.dir, `data-${this.instance}.snap`), (o) =>
      this.apply(o)
    );
    replayFile(join(this.dir, this.ownName), (o) => this.apply(o));
    for (const f of shardFiles(this.dir, this.ownName)) {
      const snap = f.replace(/\.log$/, ".snap");
      replayFile(join(this.dir, snap), (o) => this.apply(o));
      const tail = TailReader.fromStart(join(this.dir, f));
      this.tails.set(f, tail);
    }
  }

  private lastPoll = 0;

  /** Pull newly appended lines from sibling logs (and discover new shards). */
  pollTails(): void {
    if (!this.aof) return;
    for (const f of shardFiles(this.dir, this.ownName)) {
      if (!this.tails.has(f)) {
        this.tails.set(f, TailReader.fromStart(join(this.dir, f)));
      }
    }
    for (const t of this.tails.values()) t.readNew((o) => this.apply(o));
    this.lastPoll = Date.now();
  }

  /** Rate-limited tail poll used on read-miss (bounds scan frequency). */
  private lazyPoll(): void {
    if (Date.now() - this.lastPoll < TAIL_MIN_INTERVAL) return;
    this.pollTails();
  }

  private randSuffix(buf: Buffer, off: number): string {
    let s = "";
    for (let k = 0; k < CODE_LEN - 1; k++) {
      s += ALPHABET[buf[off + k] % MAX_INSTANCES];
    }
    return s;
  }

  /** 8-char code: instance prefix + random suffix, retried on collision. */
  private allocCode(): string {
    for (;;) {
      const code =
        this.prefix + this.randSuffix(randomBytes(CODE_LEN - 1), 0);
      if (!this.data.has(code)) return code;
    }
  }

  /** Returns the short code, or null if the alias is taken. */
  shorten(url: string, alias?: string, ttlMs?: number): string | null {
    const now = Date.now();
    const exp = ttlMs ? now + ttlMs : null;
    const code = alias ?? this.allocCode();
    if (alias !== undefined && this.data.has(alias)) return null;
    this.data.set(code, { u: url, a: now, e: exp, h: 0, oh: 0, i: this.instance });
    this.aof?.push(rowLine(code, esc(url), now, exp, this.instance));
    if (this.aof && this.aof.pendingBytes > FLUSH_BYTES) this.aof.flush();
    return code;
  }

  /** Bulk create; returns codes aligned with input order. */
  shortenMany(urls: string[], ttlMs?: number): string[] {
    const now = Date.now();
    const exp = ttlMs ? now + ttlMs : null;
    const codes = new Array<string>(urls.length);
    const bytes = randomBytes(urls.length * (CODE_LEN - 1)); // one CSPRNG call
    for (let i = 0; i < urls.length; i++) {
      let code = this.prefix + this.randSuffix(bytes, i * (CODE_LEN - 1));
      while (this.data.has(code)) code = this.allocCode();
      this.data.set(code, {
        u: urls[i],
        a: now,
        e: exp,
        h: 0,
        oh: 0,
        i: this.instance,
      });
      this.aof?.push(rowLine(code, esc(urls[i]), now, exp, this.instance));
      codes[i] = code;
    }
    if (this.aof && this.aof.pendingBytes > FLUSH_BYTES) this.aof.flush();
    return codes;
  }

  /** Tail the shard that owns `code`'s prefix (generated codes only). */
  private tailOwner(code: string): void {
    const owner = ALPHABET.indexOf(code[0]);
    if (owner < 0 || owner === this.instance || !this.aof) return;
    const name = `data-${owner}.log`;
    let t = this.tails.get(name);
    if (!t) {
      t = TailReader.fromStart(join(this.dir, name));
      this.tails.set(name, t);
    }
    t.readNew((o) => this.apply(o));
  }

  /** Returns target url, or null for miss/expired. Counts a hit on success. */
  resolve(code: string): string | null {
    let e = this.data.get(code);
    if (!e) {
      // maybe a sibling wrote it and we haven't tailed yet: prefix targets
      // the owning shard; lazyPoll catches aliases and anything else
      if (this.aof) {
        this.tailOwner(code);
        e = this.data.get(code);
        if (!e) {
          this.lazyPoll();
          e = this.data.get(code);
        }
      }
      if (!e) return null;
    }
    if (e.e !== null && e.e <= Date.now()) return null;
    if (TRACK_HITS) {
      e.h++;
      e.oh++;
      this.pendingHits.set(code, (this.pendingHits.get(code) ?? 0) + 1);
    }
    return e.u;
  }

  isEmpty(): boolean {
    return this.data.size === 0;
  }

  /**
   * Update url/ttl in place. Durable only on the owning instance — mutations
   * are ordered within the owner's log, so "remote" tells the caller to route
   * to instance e.i (generated codes: owner = ALPHABET.indexOf(code[0])).
   */
  update(
    code: string,
    url: string,
    ttlMs?: number
  ): "ok" | "missing" | "remote" {
    const e = this.data.get(code);
    if (!e) return "missing";
    if (e.i !== this.instance) return "remote";
    const exp = ttlMs === undefined ? e.e : ttlMs > 0 ? Date.now() + ttlMs : null;
    e.u = url;
    e.e = exp;
    // n=0: hits continue accumulating via delta lines (see compact/apply)
    this.aof?.push(rowLine(code, esc(url), e.a, exp, this.instance));
    return "ok";
  }

  /** Delete a link. Same owner rule as update(). */
  remove(code: string): "ok" | "missing" | "remote" {
    const e = this.data.get(code);
    if (!e) return "missing";
    if (e.i !== this.instance) return "remote";
    this.data.delete(code);
    this.aof?.push(`{"x":"${code}"}`);
    return "ok";
  }

  /** O(n) scan for UI listing — admin path, not the hot path. */
  list(
    limit: number,
    offset: number,
    sort: "created" | "hits",
    q?: string
  ): { links: Link[]; total: number } {
    const items: Link[] = [];
    for (const [code, e] of this.data) {
      if (q && !code.includes(q) && !e.u.includes(q)) continue;
      items.push({
        code,
        url: e.u,
        hits: e.h,
        created_at: e.a,
        expires_at: e.e,
      });
    }
    items.sort(
      sort === "hits"
        ? (x, y) => y.hits - x.hits
        : (x, y) => y.created_at - x.created_at
    );
    return { links: items.slice(offset, offset + limit), total: items.length };
  }

  stats(code: string): Link | null {
    const e = this.data.get(code);
    if (!e) return null;
    return {
      code,
      url: e.u,
      hits: e.h,
      created_at: e.a,
      expires_at: e.e,
    };
  }

  /** Bulk-insert urls through the normal write path. Returns count. */
  seed(urls: string[]): number {
    this.shortenMany(urls);
    this.flush();
    return urls.length;
  }

  /** Persist hit deltas + all queued rows; one write + fsync. */
  flush(): void {
    if (this.pendingHits.size > 0 && this.aof) {
      for (const [code, d] of this.pendingHits) {
        this.aof.push(`{"h":"${code}","d":${d},"i":${this.instance}}`);
      }
    }
    this.pendingHits.clear();
    this.aof?.flush();
  }

  /** Rewrite own rows as a compact snapshot, then truncate own log. */
  compact(): void {
    if (!this.aof) return;
    this.flush();
    const snapPath = join(this.dir, `data-${this.instance}.snap`);
    const chunks: Buffer[] = [];
    for (const [code, e] of this.data) {
      if (e.i === this.instance) {
        chunks.push(
          Buffer.from(rowLine(code, esc(e.u), e.a, e.e, e.i, e.oh) + "\n")
        );
      }
    }
    const tmp = snapPath + ".tmp";
    writeFileSync(tmp, Buffer.concat(chunks));
    renameSync(tmp, snapPath);
    this.aof.truncate();
  }

  close(): void {
    clearInterval(this.flushTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.tailTimer) clearInterval(this.tailTimer);
    for (const t of this.tails.values()) t.close();
    this.tails.clear();
    this.flush();
    this.aof?.sync();
    this.aof?.close();
    this.release();
  }
}
