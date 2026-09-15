import Database from "better-sqlite3";
import { encode } from "./base62.js";

export interface Link {
  code: string;
  url: string;
  hits: number;
  created_at: number;
  expires_at: number | null;
}

interface CachedEntry {
  url: string;
  exp: number | null;
}

export class Store {
  private db: Database.Database;
  private cache = new Map<string, CachedEntry | null>();
  private pendingHits = new Map<string, number>();
  private flushTimer: NodeJS.Timeout;
  private maxCache: number;

  private stmtInsert: Database.Statement;
  private stmtInsertAlias: Database.Statement;
  private stmtSetCode: Database.Statement;
  private stmtGetByCode: Database.Statement;
  private stmtBump: Database.Statement;
  private stmtStats: Database.Statement;
  private createGenerated: (
    url: string,
    now: number,
    exp: number | null
  ) => string;

  constructor(path: string, maxCache = 10_000) {
    this.maxCache = maxCache;
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(`CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      url TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    )`);
    this.stmtInsert = this.db.prepare(
      "INSERT INTO links (url, created_at, expires_at) VALUES (?, ?, ?)"
    );
    this.stmtInsertAlias = this.db.prepare(
      "INSERT INTO links (code, url, created_at, expires_at) VALUES (?, ?, ?, ?)"
    );
    this.stmtSetCode = this.db.prepare("UPDATE links SET code = ? WHERE id = ?");
    this.stmtGetByCode = this.db.prepare(
      "SELECT url, expires_at FROM links WHERE code = ?"
    );
    this.stmtBump = this.db.prepare(
      "UPDATE links SET hits = hits + ? WHERE code = ?"
    );
    this.stmtStats = this.db.prepare(
      "SELECT code, url, hits, created_at, expires_at FROM links WHERE code = ?"
    );
    this.createGenerated = this.db.transaction(
      (url: string, now: number, exp: number | null): string => {
        const { lastInsertRowid } = this.stmtInsert.run(url, now, exp);
        const code = encode(Number(lastInsertRowid));
        this.stmtSetCode.run(code, lastInsertRowid);
        return code;
      }
    );
    this.flushTimer = setInterval(() => this.flushHits(), 5_000);
    this.flushTimer.unref();
  }

  /** Returns the short code, or null if the alias is taken. */
  shorten(url: string, alias?: string, ttlMs?: number): string | null {
    const now = Date.now();
    const exp = ttlMs ? now + ttlMs : null;
    if (alias !== undefined) {
      try {
        this.stmtInsertAlias.run(alias, url, now, exp);
      } catch {
        return null;
      }
      this.cacheSet(alias, { url, exp });
      return alias;
    }
    const code = this.createGenerated(url, now, exp);
    this.cacheSet(code, { url, exp });
    return code;
  }

  /** Returns target url, or null for miss/expired. Counts a hit on success. */
  resolve(code: string): string | null {
    let entry = this.cache.get(code);
    if (entry === undefined) {
      const row = this.stmtGetByCode.get(code) as
        | { url: string; expires_at: number | null }
        | undefined;
      entry = row ? { url: row.url, exp: row.expires_at } : null;
      this.cacheSet(code, entry);
    }
    if (entry === null) return null;
    if (entry.exp !== null && entry.exp <= Date.now()) return null;
    this.pendingHits.set(code, (this.pendingHits.get(code) ?? 0) + 1);
    return entry.url;
  }

  isEmpty(): boolean {
    return this.db.prepare("SELECT 1 FROM links LIMIT 1").get() === undefined;
  }

  stats(code: string): Link | null {
    const row = this.stmtStats.get(code) as Link | undefined;
    if (!row) return null;
    return { ...row, hits: row.hits + (this.pendingHits.get(code) ?? 0) };
  }

  /** Bulk-insert urls; rows get codes from their rowids. Returns count. */
  seed(urls: string[]): number {
    const now = Date.now();
    const tx = this.db.transaction((list: string[]) => {
      for (const u of list) {
        const { lastInsertRowid } = this.stmtInsert.run(u, now, null);
        this.stmtSetCode.run(encode(Number(lastInsertRowid)), lastInsertRowid);
      }
    });
    tx(urls);
    return urls.length;
  }

  private cacheSet(code: string, entry: CachedEntry | null): void {
    if (this.maxCache <= 0) return;
    if (this.cache.size >= this.maxCache) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(code, entry);
  }

  flushHits(): void {
    if (this.pendingHits.size === 0) return;
    const tx = this.db.transaction((hits: Map<string, number>) => {
      for (const [code, n] of hits) this.stmtBump.run(n, code);
    });
    tx(this.pendingHits);
    this.pendingHits.clear();
  }

  close(): void {
    clearInterval(this.flushTimer);
    this.flushHits();
    this.db.close();
  }
}
