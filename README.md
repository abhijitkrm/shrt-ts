# urlshort-ts

High-performance URL shortener backend. TypeScript, **one runtime dependency** (`uWebSockets.js`).

Architecture chosen by measurement, not default — see [Performance](#performance).

- **HTTP**: `uWebSockets.js` (C++ engine) default; `node:http` + `node:cluster` fallback (`SERVER=node`)
- **Storage**: custom append-only-log (AOF) — in-memory `Map` index + batched `write()`/`fsync`.
  Reads never touch disk; writes are ~ns enqueue + one syscall batch per 5 ms.
- **Codes**: `encode(instance * 2³² + seq)` → base62. Globally unique across processes
  with zero coordination (no shared counter, no distributed lock).
- **Multi-instance**: per-instance log shards (`data-<i>.log`); siblings discovered and
  tailed **lazily on read-miss** — writes never pay replication cost, so write
  throughput scales ~linearly with instance count.
- **Durability**: every append reaches the OS page cache within 5 ms and is fsync'd
  every 500 ms — a process crash loses ≤5 ms of writes, a machine crash ≤~500 ms
  (tunable constants in `src/store.ts`; snapshot+truncate via `compact()`).

## Quickstart

```sh
pnpm install
pnpm build
pnpm start            # uWS on :3000
pnpm dev              # same, via tsx
pnpm start:node       # node:http + cluster fallback
WORKERS=4 pnpm start  # 4 instances: uWS binds PORT..PORT+3, node shares PORT
pnpm test             # node:test suite (23 tests)
pnpm bench            # build + spawn real servers + autocannon scenarios
```

## API

| Method | Path | Body / Response |
|---|---|---|
| `POST` | `/api/shorten` | `{url, alias?, ttl_ms?}` → `201 {code, short_url}`; `409` alias taken; `400` invalid |
| `POST` | `/api/shorten/bulk` | `{urls: […≤10000]}` → `201 {count, codes}` (body ≤1 MB, fast-path validation) |
| `GET` | `/{code}` | `302` + `Location`; `404` unknown/expired |
| `GET` | `/api/stats/{code}` | `{code, url, hits, created_at, expires_at}` |
| `GET` | `/api/health` | `{ok: true}` |

Codes/aliases: `[0-9A-Za-z_-]{1,64}`. Single POST body ≤4 KB.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | base listen port |
| `DATA_DIR` | `data` | shard log directory (`data-<i>.log`, `data-<i>.snap`) |
| `SERVER` | `uws` | `uws` or `node` |
| `WORKERS` | `1` | processes: uWS binds `PORT+i`, node shares `PORT` |
| `INSTANCE` | auto | instance id (auto-claimed via `instance-<i>.lock` files) |
| `SEED` | `0` | bulk-insert N links if empty (codes `1..N`) |
| `HITS` | `1` | `0` disables hit counting (removes ~2 map ops/redirect) |
| `TAIL_MS` | `0` | >0 enables periodic sibling-log polling (on-miss always on) |

## Performance

Measured on an M1 MacBook (4P+4E cores, 16 GB), macOS, Node 18. `pnpm bench`:
autocannon, 64 conns, 5 s, 50k seeded links, **client and server share the same
machine** — absolute numbers are a floor; run-to-run variance on this busy laptop
was ±30-50%. Values below are best observed.

### HTTP throughput

| scenario | req/s | rows/s | avg lat | p99 |
|---|---|---|---|---|
| redirect (uws ×1) | **133,229** | — | 0.09 ms | 2 ms |
| redirect (uws ×1, pipelined ×10) | **320,230** | — | 1.56 ms | 5 ms |
| mixed 95% read / 5% write (uws) | 115,283 | — | 0.12 ms | 2 ms |
| shorten single (uws) | 71,619 | 71.6k | 0.33 ms | 3 ms |
| **bulk ×1000 (uws)** | 640 | **640k** | 98 ms | 372 ms |
| **bulk ×1000 (uws ×4 inst.)** | 1,413 | **1.41M** | — | — |
| redirect (node w1) | 79,110 | — | 0.24 ms | 2 ms |
| redirect (node w4 cluster) | 76,010 | — | 0.38 ms | 3 ms |
| shorten (node w1) | 30,464 | 30.5k | 1.33 ms | 5 ms |

### Raw storage (in-process, no HTTP)

| op | ops/s |
|---|---|
| `resolve()` — map.get + hit count | **3.1M**/s |
| `shortenMany()` — enqueue + serialize | **1.46M**/s |
| better-sqlite3 read (prepared get) | ~0.5M/s |
| better-sqlite3 write (per-op txn) | ~21k/s |
| better-sqlite3 insert (batched txn) | ~0.5-0.8M/s |
| turso 0.7.2 read / write | ~0.2M/s / ~23k/s |

### The 1M writes / 100M reads question

**Writes — achieved: 1.41M rows/s durable** over HTTP via `/api/shorten/bulk`
across 4 instances on this laptop (raw enqueue ceiling ~1.5M/s/thread).
Per-request commits can't get here — the win comes from write-behind + group
commit + instance-disjoint code space (no coordination).

**Reads — physics says no to 100M/s on one box.** HTTP costs ~3-7 µs/req in the
best measured engine (uWS); that puts one core at ~150-300k req/s and this whole
machine at ~1-2M/s even with perfect scaling. 100M/s over HTTP needs a fleet
(~30-100 machines) or in-process access (3.1M/s/thread here — ~30 threads of pure
`Map.get` with no I/O). The read path is already at its floor: a single Map lookup.

### What the loop tried (all measured, honest outcomes)

| experiment | result | verdict |
|---|---|---|
| `node:http` single | 80k req/s | kept as `SERVER=node` fallback |
| `node:cluster` ×4/×8 | no gain on-box (client shares cores) | kept for multi-core hosts |
| `--max-semi-space-size=64` | −18% | rejected |
| Bun `Bun.serve`+`bun:sqlite` | adapter overhead erased edge; collapses on pipelining (33k); better-sqlite3 crashes it | rejected |
| `better-sqlite3` write-behind | 21k→70k/s single writes | superseded by AOF |
| **turso `@tursodatabase/database`** | 2.3× slower reads, ~17% slower writes, **exclusive file lock breaks multi-process** | rejected |
| fsync every 5 ms | −75% throughput (loop blocked) | fsync moved to 500 ms |
| periodic sibling tailing | −40% aggregate writes (every proc parsed all traffic) | replaced with lazy on-miss |
| uWS `onData` shared ArrayBuffer | latent corruption/crash on multi-chunk bodies | fixed: copy per chunk |

### Consistency model

- Own writes: visible immediately (in-memory index), durable ≤5 ms.
- Sibling writes: visible after a read-miss triggers a tail (rate-limited 200 ms)
  or after `TAIL_MS` periodic polling if enabled.
- Alias collision across instances within the convergence window: last-writer-wins.
- Hit counts merge via delta lines; per-proc stats eventually consistent.

## Layout

```
src/base62.ts   id -> short code
src/aof.ts      append-only log: buffered writes, replay, tailing, instance locks
src/store.ts    in-memory index + write-behind + multi-instance merge
src/app.ts      transport-agnostic handle() + node:http adapter
src/uws.ts      uWebSockets.js adapter (default server)
src/index.ts    env config, cluster fan-out, seeding
test/           node:test suites (23 tests)
bench/bench.ts  spawns real server processes, autocannon scenarios
```
