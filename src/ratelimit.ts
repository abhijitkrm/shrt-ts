// Per-IP token bucket for write endpoints (abuse control on a public
// shortener). Off by default: RATE_LIMIT=<req/s per IP> enables it;
// RATE_LIMIT_BURST sets bucket capacity (default = RATE_LIMIT).
// POST /api/shorten costs 1 token; /api/shorten/bulk costs urls count.

const MAX_KEYS = 1 << 18; // bounded: ~256k tracked IPs
const IDLE_MS = 60_000;

interface Bucket {
  tokens: number;
  lastMs: number;
}

export class RateLimiter {
  private readonly m = new Map<string, Bucket>();
  constructor(
    private readonly rate: number,
    private readonly burst: number
  ) {}

  /** cost tokens from ip's bucket; true when allowed. Disabled → true. */
  allow(ip: string, cost: number): boolean {
    if (this.rate <= 0) return true;
    const now = Date.now();
    if (this.m.size >= MAX_KEYS) {
      for (const [k, b] of this.m) if (now - b.lastMs > IDLE_MS) this.m.delete(k);
    }
    let b = this.m.get(ip);
    if (!b) {
      b = { tokens: this.burst, lastMs: now };
      this.m.set(ip, b);
    }
    b.tokens = Math.min(b.tokens + ((now - b.lastMs) / 1000) * this.rate, this.burst);
    b.lastMs = now;
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return true;
    }
    return false;
  }
}

let rl: RateLimiter | undefined;

/** Process-wide limiter, built from env on first use. */
export function limiter(): RateLimiter {
  if (rl === undefined) {
    const rate = Math.max(0, Number(process.env.RATE_LIMIT) || 0);
    let burst = Number(process.env.RATE_LIMIT_BURST) || rate;
    if (burst < 1) burst = 1;
    rl = new RateLimiter(rate, burst);
  }
  return rl;
}

/** Requests rejected (exported via /metrics). */
export let rateLimited = 0;
export function incLimited(): void {
  rateLimited++;
}

/** Test hook: reinstall from explicit settings. */
export function initForTest(rate: number, burst: number): void {
  rl = new RateLimiter(Math.max(0, rate), Math.max(1, burst));
}
/** Test hook: re-read env and reset state. */
export function reloadForTest(): void {
  rl = undefined;
}
