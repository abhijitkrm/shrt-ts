# urlshort-ts

High-performance URL shortener backend. TypeScript, ~4 source files, 2 runtime deps.

- **HTTP**: `uWebSockets.js` (C++ engine) by default; `node:http` + `node:cluster` fallback
- **Storage**: `better-sqlite3` — WAL mode, prepared statements, `busy_timeout`
- **Codes**: `AUTOINCREMENT` rowid → base62 (shortest possible, collision-free)
- **Hot path**: bounded in-memory cache (positive + negative); hit counters buffered in memory and flushed to SQLite every 5s — redirects never write to the DB

## Quickstart

```sh
pnpm install
pnpm build
pnpm start          # uWS server on :3000
pnpm dev            # same, via tsx (no build)
pnpm start:node     # node:http + cluster fallback
pnpm test           # node:test suite (17 tests)
pnpm bench          # builds, then benchmarks all server variants
```

## API

| Method | Path | Body / Response |
|---|---|---|
| `POST` | `/api/shorten` | `{url, alias?, ttl_ms?}` → `201 {code, short_url}`; `409` if alias taken; `400` invalid |
| `GET` | `/{code}` | `302` + `Location`; `404` unknown/expired |
| `GET` | `/api/stats/{code}` | `{code, url, hits, created_at, expires_at}` |
| `GET` | `/api/health` | `{ok: true}` |

Codes/aliases: `[0-9A-Za-z_-]{1,64}`. POST body limit: 4 KB.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `DB_PATH` | `urls.db` | SQLite file |
| `CACHE_MAX` | `10000` | redirect cache entries (FIFO eviction; `0` disables) |
| `SERVER` | `uws` | `uws` or `node` |
| `WORKERS` | `1` | cluster workers (`SERVER=node`: shared port; `SERVER=uws`: each binds `PORT+i`) |
| `SEED` | `0` | bulk-insert N rows if DB is empty (codes `encode(1..N)`) |

## Measured performance

Apple M1, 8 cores, 16 GB. `pnpm bench`: autocannon, 64 conns, 2 client threads, 5 s,
50k seeded links. Client runs on-box — absolute numbers are a floor, not a ceiling.

| scenario | req/s | avg lat | p99 |
|---|---|---|---|
| redirect, hot (uws) | **106,541** | 0.16 ms | 2 ms |
| redirect, hot (uws, pipelined ×10) | **267,686** | 1.86 ms | 5 ms |
| mixed 95% read / 5% write (uws) | 79,418 | 0.29 ms | 3 ms |
| shorten (uws) | 13,908 | 4.10 ms | 12 ms |
| redirect, hot (node w1) | 79,110 | 0.24 ms | 2 ms |
| redirect, hot (node w4) | 76,010 | 0.38 ms | 3 ms |
| redirect, cold/no-cache (node w1) | 49,648 | 0.84 ms | 3 ms |
| shorten (node w1) | 13,402 | 4.27 ms | 11 ms |

Raw storage throughput (no HTTP): ~609k reads/s, ~21k writes/s.

### What the loop tried

- **uWS > node:http**: +35% at realistic pipelining, ~2.6× single-process ceiling. Kept as default.
- **Cluster (node:http)**: no gain on-box — benchmark client and workers share the same 8 cores.
  Kept for multi-core hosts where the client is remote.
- **`--max-semi-space-size`**: measured −18%, rejected.
- **Bun (`Bun.serve` + `bun:sqlite`)**: adapter overhead erased its edge (~equal to node at p1),
  and it collapses on pipelined requests (33k vs node's 133k). Removed.
- **Write batching**: rejected — ~14k creates/s is far above real shortener demand, and the
  write ceiling is SQLite's single-writer WAL anyway.

### Scaling notes

- uWS can't share a port across processes. To use all cores: run N instances on
  `PORT..PORT+N-1` (`WORKERS=N SERVER=uws` does this) behind any LB.
- Per-instance caches are independent: an alias created on instance A may be
  negatively cached on instance B until eviction. Same for hit counts (they merge
  in SQLite every 5 s). If you need strict cross-instance consistency, put Redis
  behind `Store` — the tradeoff is ~50-200 µs added latency per lookup.
- Writes are serialized by SQLite's single writer. For write-heavy workloads,
  shard by code prefix or move storage to a networked DB.

## Layout

```
src/base62.ts   rowid -> short code
src/store.ts    SQLite + cache + buffered hit counts
src/app.ts      transport-agnostic handle() + node:http adapter
src/uws.ts      uWebSockets.js adapter (default server)
src/index.ts    entrypoint: env config, cluster fan-out, seeding
test/           node:test suites (run: pnpm test)
bench/bench.ts  spawns real servers, autocannon scenarios (pnpm bench)
```
