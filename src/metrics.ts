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
