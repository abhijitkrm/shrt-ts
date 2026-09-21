# urlshort-ts

High-performance URL shortener backend. TypeScript, **one runtime dependency** (`uWebSockets.js`).

Architecture chosen by measurement, not default — see [Performance](#performance).

- **HTTP**: `uWebSockets.js` (C++ engine) default; `node:http` + `node:cluster` fallback (`SERVER=node`)
- **Storage**: custom append-only-log (AOF) — in-memory `Map` index + batched `write()`/`fsync`.
  Reads never touch disk; writes are ~ns enqueue + one syscall batch per 5 ms.
- **Codes**: 8 chars = `ALPHABET[instance]` + 7 random base62 chars (62⁷ ≈ 3.5T
  per instance). The prefix shard-marks every code — unique across processes with
  zero coordination, and a read-miss knows exactly which sibling log to tail.
  Checked against the index and retried on collision.
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
| `POST` | `/api/shorten` | `{url, alias?, ttl_ms?}` → `201 {code, short_url}`; `409` alias taken; `400` invalid. `ttl_ms` defaults to and is capped at `LINK_TTL_MS` (1 day) |
| `POST` | `/api/shorten/bulk` | `{urls: […≤10000]}` → `201 {count, codes}` (body ≤1 MB, fast-path validation) |
| `GET` | `/{code}` | `302` + `Location`; `404` unknown/expired |
| `GET` | `/api/links` | `?limit(≤1000)&offset&sort=created\|hits&q=` → `{links, total}` (O(n) scan — admin path) |
| `GET` | `/api/stats/{code}` | `{code, url, hits, created_at, expires_at}` |
| `PATCH` | `/api/links/{code}` | admin only: `{url?, ttl_ms?}` → `200`; `404` missing/not-authorized; `409` remote-owned |
| `DELETE` | `/api/links/{code}` | admin only → `204`; `404` missing/not-authorized; `409` remote-owned |
| `OPTIONS` | any | `204` CORS preflight |
| `GET` | `/` | single-file UI (`ui/index.html`) — 404 if absent |
| `GET` | `/api/metrics` | `{req_s, total, uptime_s, per_second[31]}` — live request counters |
| `GET` | `/api/health` | `{ok: true}` |

CORS: `Access-Control-Allow-Origin` on every response (`CORS_ORIGIN` env, default `*`).

`PATCH`/`DELETE` are hidden unless `ADMIN_TOKEN` is set, then require the
`x-admin-token` header — links are immutable to the public. They're durable only
on the instance that owns the code (mutations are ordered within the owner's
log); `409` means route to the owning instance — for generated codes that's
`ALPHABET.indexOf(code[0])`.

Generated codes: exactly 8 chars, `[0-9a-zA-Z]` (`ALPHABET[instance]` prefix +
7 random). Aliases: `[0-9A-Za-z_-]{1,64}`. Single POST body ≤4 KB.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | base listen port |
| `DATA_DIR` | `data` | shard log directory (`data-<i>.log`, `data-<i>.snap`) |
| `SERVER` | `uws` | `uws` or `node` |
| `WORKERS` | `1` | processes: uWS binds `PORT+i`, node shares `PORT` |
| `INSTANCE` | auto | instance id (auto-claimed via `instance-<i>.lock` files) |
| `SEED` | `0` | bulk-insert N links if empty (random codes) |
| `HITS` | `1` | `0` disables hit counting (removes ~2 map ops/redirect) |
| `TAIL_MS` | `0` | >0 enables periodic sibling-log polling (on-miss always on) |
| `CORS_ORIGIN` | `*` | value of `Access-Control-Allow-Origin` |
| `ADMIN_TOKEN` | unset | enables PATCH/DELETE; requests need `x-admin-token: <value>` |
| `LINK_TTL_MS` | `86400000` | default **and max** link lifetime — every link expires ≤1 day |
| `STORE` | `aof` | `aof` in-process engine, or `dragonfly`/`redis` external RESP KV |
| `DRAGONFLY_ADDR` | `127.0.0.1:6379` | RESP endpoint (`KV_ADDR` also accepted) |
| `CACHE` | `100000` | bounded hot FIFO entries kept in-process over the KV |
| `CACHE_TTL_MS` | `5000` | staleness bound for cached entries |

With `STORE=dragonfly` the whole corpus lives in the RESP store (keys
`l:{code}` → `{exp}|{created}|{url}`, `h:{code}` → hit counter, batched
`INCRBY` every 5 ms) — process memory stays flat as links grow; a cache
miss costs one `GET`. The request path becomes async (`handle()` returns a
promise) since reads may hit the network. Writes and admin mutations work
on any node. Live tests: `SHRT_KV_ADDR=127.0.0.1:6379 pnpm test`.

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

### Capacity: what 1B links cost (measured on this build)

| tier | per link (64-char url) | ×1B |
|---|---|---|
| RAM — `Map` + entry objects | ~282 B | **~262 GiB** |
| disk — AOF row lines | ~131 B | **~122 GiB** (+ hit deltas) |

The RAM cost is the architecture's real constraint — an in-memory index this
large wants either a big-memory host or prefix-sharding across ~3-4 machines
(`code[0]` routes to the owner). Disk is cheap by comparison; `compact()`
bounds log growth and hit deltas dominate churn, not rows.

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
- Sibling writes: a read-miss tails the shard owning the code's prefix (or all
  shards for aliases, rate-limited 200 ms); `TAIL_MS` periodic polling optional.
- Alias collision across instances within the convergence window: last-writer-wins.
- Hit counts merge via delta lines; per-proc stats eventually consistent.

## Run on a server

Requires Node ≥ 18 (uWS ships prebuilt linux-x64/arm64 binaries). One host,
one data dir:

```sh
git clone <repo> && cd urlshort-ts
pnpm install && pnpm build
sudo mkdir -p /var/lib/urlshort
DATA_DIR=/var/lib/urlshort PORT=8080 node dist/index.js
```

systemd unit (`/etc/systemd/system/urlshort.service`):

```ini
[Unit]
Description=urlshort
After=network.target

[Service]
Environment=DATA_DIR=/var/lib/urlshort PORT=8080 SERVER=uws WORKERS=8
WorkingDirectory=/opt/urlshort
ExecStart=/usr/bin/node dist/index.js
Restart=always
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
```

`WORKERS=8` binds ports `8080..8087` — put nginx/HAProxy in front:

```nginx
upstream urlshort {
    least_conn;
    server 127.0.0.1:8080; server 127.0.0.1:8081;
    server 127.0.0.1:8082; server 127.0.0.1:8083;
    server 127.0.0.1:8084; server 127.0.0.1:8085;
    server 127.0.0.1:8086; server 127.0.0.1:8087;
}
server { listen 80; location / { proxy_pass http://urlshort; } }
```

Notes:

- **All instances must share one host** — replication is file-based; multi-host
  writes need an external store (or shard at the LB: generated codes carry their
  instance prefix in `code[0]`, so an LB can route `/{code}` by first char).
- `DATA_DIR` on local SSD; backup = copy the directory (crash-safe up to the
  last fsync). Run `store.compact()` periodically to bound log growth.
- No fsync per write — that's the throughput trade. If you need it, add
  `aof.sync()` after `flush()` in `Store` (expect ~10-20k writes/s instead).
- Tune file limits: `LimitNOFILE` above + `ulimit -n`.

## Layout

```
src/base62.ts   base62 alphabet/encode; code space: prefix + random suffix
src/aof.ts      append-only log: buffered writes, replay, tailing, instance locks
src/store.ts    in-memory index + write-behind + multi-instance merge
src/app.ts      transport-agnostic handle() + node:http adapter
src/uws.ts      uWebSockets.js adapter (default server)
src/index.ts    env config, cluster fan-out, seeding
src/metrics.ts  per-second request ring buffer -> GET /api/metrics
ui/index.html   single-file management UI served at GET / (no build step)
test/           node:test suites
bench/bench.ts  spawns real server processes, autocannon scenarios
```
