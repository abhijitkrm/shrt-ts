/** In-process request metrics: per-second ring buffer + totals. */
const N = 60;
const buckets = new Float64Array(N);
const started = Date.now();
let cur = Math.floor(started / 1000);
let total = 0;

export function tick(): void {
  total++;
  const s = Math.floor(Date.now() / 1000);
  if (s !== cur) {
    for (let t = cur + 1; t <= s; t++) buckets[t % N] = 0;
    cur = s;
  }
  buckets[s % N]++;
}

export function snapshot(): {
  req_s: number;
  total: number;
  uptime_s: number;
  per_second: number[];
} {
  const s = Math.floor(Date.now() / 1000);
  const window_ = new Array<number>(31);
  for (let i = 0; i < 31; i++) {
    const t = s - 30 + i; // last 30 complete seconds + current partial
    window_[i] = t > cur || cur - t >= N ? 0 : buckets[t % N];
  }
  const last5 = window_.slice(25, 30).reduce((a, b) => a + b, 0);
  return {
    req_s: Math.round((last5 / 5) * 10) / 10,
    total,
    uptime_s: Math.floor((Date.now() - started) / 1000),
    per_second: window_,
  };
}

// ---- counters for the Prometheus /metrics endpoint ----
// ops: redirect, shorten, shorten_bulk, update, delete, list, stats,
// health, metrics, ui, other
const OPS = [
  "redirect", "shorten", "shorten_bulk", "update", "delete", "list",
  "stats", "health", "metrics", "ui", "other",
] as const;
const opCounts = new Float64Array(OPS.length);
const statusCounts = new Float64Array(4); // 2xx 3xx 4xx 5xx
let cacheHit = 0, cacheMiss = 0, storeReads = 0, storeReadUs = 0,
    storeWrites = 0, linksTotal = 0;

export function op(i: number): void { opCounts[i]++; }
export function status(code: number): void {
  statusCounts[code >= 200 && code < 300 ? 0
    : code >= 300 && code < 400 ? 1
    : code >= 400 && code < 500 ? 2 : 3]++;
}
export function cacheHitInc(): void { cacheHit++; }
export function cacheMissInc(): void { cacheMiss++; }
export function storeRead(us: number): void { storeReads++; storeReadUs += us; }
export function storeWrite(): void { storeWrites++; }
export function linksDelta(n: number): void { linksTotal += n; }

/** Prometheus text exposition — /metrics endpoint. */
export function prometheus(rateLimitedN: number): string {
  const line = (m: string, labels: string, v: number): string =>
    labels ? `${m}{${labels}} ${v}\n` : `${m} ${v}\n`;
  let b = "# HELP shrt_requests_total Requests by operation\n"
        + "# TYPE shrt_requests_total counter\n";
  for (let i = 0; i < OPS.length; i++)
    b += line("shrt_requests_total", `op="${OPS[i]}"`, opCounts[i]);
  b += "# HELP shrt_responses_total Responses by status class\n"
     + "# TYPE shrt_responses_total counter\n";
  for (const [i, cls] of ["2xx", "3xx", "4xx", "5xx"].entries())
    b += line("shrt_responses_total", `class="${cls}"`, statusCounts[i]);
  b += "# HELP shrt_cache_lookups_total Local hot-cache lookups\n"
     + "# TYPE shrt_cache_lookups_total counter\n"
     + line("shrt_cache_lookups_total", 'result="hit"', cacheHit)
     + line("shrt_cache_lookups_total", 'result="miss"', cacheMiss)
     + "# HELP shrt_store_reads_total Backing-store point reads (cache misses)\n"
     + "# TYPE shrt_store_reads_total counter\n"
     + line("shrt_store_reads_total", "", storeReads)
     + "# HELP shrt_store_read_us_total Cumulative backing-store read latency (us)\n"
     + "# TYPE shrt_store_read_us_total counter\n"
     + line("shrt_store_read_us_total", "", storeReadUs)
     + "# HELP shrt_store_writes_total Backing-store writes\n"
     + "# TYPE shrt_store_writes_total counter\n"
     + line("shrt_store_writes_total", "", storeWrites)
     + "# HELP shrt_rate_limited_total Requests rejected by the rate limiter\n"
     + "# TYPE shrt_rate_limited_total counter\n"
     + line("shrt_rate_limited_total", "", rateLimitedN)
     + "# HELP shrt_links_total Live links created minus deleted\n"
     + "# TYPE shrt_links_total gauge\n"
     + line("shrt_links_total", "", linksTotal)
     + "# HELP shrt_uptime_seconds Process uptime\n"
     + "# TYPE shrt_uptime_seconds gauge\n"
     + line("shrt_uptime_seconds", "", Math.floor((Date.now() - started) / 1000));
  return b;
}
