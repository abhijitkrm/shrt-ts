// openstore.ts — STORE env dispatch: aof|local (default) opens the
// in-process AOF engine; dragonfly|redis|kv opens the external RESP
// backend; rocksdb opens the embedded store (ROCKSDB_PATH,
// default {dir}/rocks — single-writer file lock). DRAGONFLY_ADDR/KV_ADDR
// (default 127.0.0.1:6379), CACHE
// (100000 hot FIFO entries), CACHE_TTL_MS (5000 staleness bound).

import { Store } from "./store.js";
import { KvStore } from "./kvstore.js";
import { RocksStore } from "./rocksstore.js";
import type { StoreApi } from "./storeapi.js";

export async function openStore(
  dir: string,
  instance?: number
): Promise<StoreApi> {
  const mode = process.env.STORE ?? "aof";
  if (mode === "rocksdb" || mode === "rocks") {
    const path =
      process.env.ROCKSDB_PATH ?? `${dir}/rocks`;
    const cache = Number(process.env.CACHE ?? 100000);
    const ttl = Number(process.env.CACHE_TTL_MS ?? 5000);
    return RocksStore.open(path, instance ?? 0, cache, ttl);
  }
  if (mode === "dragonfly" || mode === "redis" || mode === "kv") {
    const addr =
      process.env.DRAGONFLY_ADDR ??
      process.env.KV_ADDR ??
      "127.0.0.1:6379";
    const cache = Number(process.env.CACHE ?? 100000);
    const ttl = Number(process.env.CACHE_TTL_MS ?? 5000);
    return KvStore.open(addr, instance ?? 0, cache, ttl);
  }
  return new Store(dir, instance);
}
