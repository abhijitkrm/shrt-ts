import { spawn, ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import autocannon, { Request } from "autocannon";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DURATION = Number(process.env.BENCH_DURATION ?? 5);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 64);
const KEYSPACE = 50_000;
const TMP = tmpdir();

let portSeq = 4300;

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

async function waitHealthy(port: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`server :${port} did not start`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function startServer(
  env: Record<string, string>,
  ports: number[]
): Promise<ChildProcess> {
  const proc = spawn("node", ["dist/index.js"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  await Promise.all(ports.map(waitHealthy));
  return proc;
}

function stopServer(proc: ChildProcess): Promise<void> {
  return new Promise((r) => {
    proc.on("exit", () => r());
    try {
      process.kill(-proc.pid!, "SIGTERM"); // kill process group (workers too)
    } catch {
      proc.kill("SIGTERM");
    }
    setTimeout(r, 3000).unref();
  });
}

interface CannonOpts {
  workers?: number;
  pipelining?: number;
}

async function cannon(
  port: number,
  requests: Request[],
  opts: CannonOpts = {}
) {
  return autocannon({
    url: `http://127.0.0.1:${port}`,
    connections: CONNECTIONS,
    duration: DURATION,
    requests,
    workers: opts.workers ?? 2,
    pipelining: opts.pipelining ?? 1,
  });
}

function report(name: string, res: any, rowsPerReq = 1): void {
  const errors = res.errors + res.timeouts;
  console.log(
    `${name.padEnd(24)} ${fmt(res.requests.average).padStart(10)} req/s  ` +
      `${fmt(res.requests.average * rowsPerReq).padStart(10)} rows/s  ` +
      `lat avg ${res.latency.average.toFixed(2).padStart(6)}ms  ` +
      `p99 ${String(res.latency.p99).padStart(6)}ms  ` +
      `3xx ${fmt(res.non2xx).padStart(9)}  err ${errors}`
  );
}

/** Create n aliased links via the API so the bench knows valid codes. */
async function makeCodes(port: number, n: number): Promise<string[]> {
  const codes = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    codes[i] = `bk${i}`;
    const res = await fetch(`http://127.0.0.1:${port}/api/shorten`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `https://bench.example/${i}`, alias: codes[i] }),
    });
    if (!res.ok) throw new Error(`alias seed failed: ${res.status}`);
  }
  return codes;
}

const redirectReqs = (codes: string[]): Request[] =>
  codes.map((c) => ({ method: "GET", path: `/${c}` }) as Request);

const writeReq: Request = {
  method: "POST",
  path: "/api/shorten",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://bench.example/write" }),
} as Request;

const BULK_N = 1000;
const bulkReq: Request = {
  method: "POST",
  path: "/api/shorten/bulk",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    urls: Array.from({ length: BULK_N }, (_, i) => `https://b.example/${i}`),
  }),
} as Request;

const envFor = (extra: Record<string, string>, tag: string) => {
  const port = portSeq;
  portSeq += 10;
  const dir = join(TMP, `bench-${tag}-${port}`);
  rmSync(dir, { recursive: true, force: true });
  return { PORT: String(port), DATA_DIR: dir, ...extra };
};

async function main() {
  console.log(
    `bench: ${CONNECTIONS} conns x ${DURATION}s, keyspace ${fmt(KEYSPACE)}\n`
  );

  // --- uWS, single instance ---
  {
    const env = envFor({ SERVER: "uws", SEED: String(KEYSPACE) }, "uws1");
    const port = Number(env.PORT);
    const srv = await startServer(env, [port]);
    const codes = await makeCodes(port, 100);
    report("redirect (uws)", await cannon(port, redirectReqs(codes)));
    report(
      "redirect (uws, p10)",
      await cannon(port, redirectReqs(codes), { pipelining: 10 })
    );
    const reqs = redirectReqs(
      Array.from({ length: 95 }, (_, i) => codes[(i * 613) % codes.length])
    );
    for (let i = 0; i < 5; i++) reqs.push(writeReq);
    report("mixed 95/5 (uws)", await cannon(port, reqs));
    report("shorten (uws)", await cannon(port, [writeReq]));
    report("bulk x1000 (uws)", await cannon(port, [bulkReq]), BULK_N);
    await stopServer(srv);
  }

  // --- node:http comparison ---
  {
    const env = envFor({ SERVER: "node", SEED: String(KEYSPACE) }, "node1");
    const port = Number(env.PORT);
    const srv = await startServer(env, [port]);
    const codes = await makeCodes(port, 100);
    report("redirect (node w1)", await cannon(port, redirectReqs(codes)));
    report("shorten (node w1)", await cannon(port, [writeReq]));
    await stopServer(srv);
  }

  // --- uWS multi-instance: 4 procs, aggregate write throughput ---
  {
    const env = envFor(
      { SERVER: "uws", WORKERS: "4", SEED: String(KEYSPACE) },
      "uws4"
    );
    const base = Number(env.PORT);
    const ports = [base, base + 1, base + 2, base + 3];
    const srv = await startServer(env, ports);
    const results = await Promise.all(
      ports.map((p) => cannon(p, [bulkReq], { workers: 1 }))
    );
    const totalRows = results.reduce(
      (a, r) => a + r.requests.average * BULK_N,
      0
    );
    const totalReqs = results.reduce((a, r) => a + r.requests.average, 0);
    console.log(
      `${"bulk x1000 (uws x4)".padEnd(24)} ${fmt(totalReqs).padStart(10)} req/s  ` +
        `${fmt(totalRows).padStart(10)} rows/s  (aggregate over ${ports.length} instances)`
    );
    // aggregate redirect throughput: aliases created on port[0]; warm each
    // port once so lazy tailing merges the rows before measurement
    const codes = await makeCodes(ports[0], 100);
    for (const p of ports) {
      for (const c of codes) {
        await fetch(`http://127.0.0.1:${p}/${c}`, { redirect: "manual" });
      }
    }
    const rresults = await Promise.all(
      ports.map((p) => cannon(p, redirectReqs(codes), { workers: 1 }))
    );
    console.log(
      `${"redirect (uws x4)".padEnd(24)} ${fmt(
        rresults.reduce((a, r) => a + r.requests.average, 0)
      ).padStart(10)} req/s  (aggregate over ${ports.length} instances)`
    );
    await stopServer(srv);
  }
}

main();
