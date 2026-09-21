// storeapi.ts — the store surface the HTTP layer uses. Store (in-process
// AOF engine) and KvStore (external RESP backend) both satisfy it. Methods
// may return T or Promise<T> — callers `await` uniformly.

import type { Link } from "./store.js";

export type MutRes = "ok" | "missing" | "remote";

export interface StoreApi {
  shorten(
    url: string,
    alias?: string,
    ttlMs?: number
  ): string | null | Promise<string | null>;
  shortenMany(urls: string[], ttlMs?: number): string[] | Promise<string[]>;
  resolve(code: string): string | null | Promise<string | null>;
  update(code: string, url: string, ttlMs?: number): MutRes | Promise<MutRes>;
  remove(code: string): MutRes | Promise<MutRes>;
  list(
    limit: number,
    offset: number,
    sort: "created" | "hits",
    q?: string
  ): { links: Link[]; total: number } | Promise<{ links: Link[]; total: number }>;
  stats(code: string): Link | null | Promise<Link | null>;
  seed(urls: string[]): number | Promise<number>;
  isEmpty(): boolean | Promise<boolean>;
  flush(): void | Promise<void>;
  pollTails(): void;
  compact(): void;
  close(): void;
}
