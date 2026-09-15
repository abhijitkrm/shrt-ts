import { spawn, ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import autocannon, { Request } from "autocannon";
import { encode } from "../src/base62.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DURATION = Number(process.env.BENCH_DURATION ?? 5);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 64);
const KEYSPACE = 50_000;
const TMP = tmpdir();

let portSeq = 4100;

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

async function startServer(env: Record<string, string>): Promise<ChildProcess> {
  const proc = spawn("node", ["dist/index.js"], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = Number(env.PORT);
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return proc;
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
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

async function run(
  name: string,
  port: number,
  requests: Request[],
  clientWorkers = 2,
  pipelining = 1
): Promise<void> {
  const res = await autocannon({
    url: `http://127.0.0.1:${port}`,
    connections: CONNECTIONS,
    duration: DURATION,
    requests,
    workers: clientWorkers,
    pipelining,
  });
  const errors = res.errors + res.timeouts;
  console.log(
    `${name.padEnd(22)} ${fmt(res.requests.average).padStart(10)} req/s  ` +
      `lat avg ${res.latency.average.toFixed(2).padStart(6)}ms  ` +
      `p99 ${String(res.latency.p99).padStart(6)}ms  ` +
      `${fmt(res.throughput.average).padStart(10)} B/s  ` +
      `3xx ${fmt(res.non2xx).padStart(9)}  err ${errors}`
  );
}

const redirectReqs = (codes: string[]): Request[] =>
  codes.map((c) => ({ method: "GET", path: `/${c}` }) as Request);

const envFor = (extra: Record<string, string>): Record<string, string> => {
  const port = String(portSeq++);
  return {
    PORT: port,
    DB_PATH: join(TMP, `bench-${port}.db`),
    SEED: String(KEYSPACE),
    ...extra,
  };
};

const writeReq: Request = {
  method: "POST",
  path: "/api/shorten",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://bench.example/write" }),
} as Request;

async function main() {
  console.log(
    `bench: ${CONNECTIONS} conns x ${DURATION}s, keyspace ${fmt(KEYSPACE)}\n`
  );

  // --- single worker scenarios ---
  {
    const env = envFor({ CACHE_MAX: "10000", SERVER: "node" });
    const srv = await startServer(env);
    const codes = Array.from({ length: 100 }, (_, i) => encode(i + 1));
    // warm the cache
    for (const c of codes) {
      await fetch(`http://127.0.0.1:${env.PORT}/${c}`, { redirect: "manual" });
    }
    await run("redirect (hot, w1)", Number(env.PORT), redirectReqs(codes));
    await stopServer(srv);
  }

  {
    const env = envFor({ CACHE_MAX: "0", SERVER: "node" });
    const srv = await startServer(env);
    const codes = Array.from({ length: 1000 }, (_, i) =>
      encode(1 + ((i * 977) % KEYSPACE))
    );
    await run("redirect (cold, w1)", Number(env.PORT), redirectReqs(codes));
    await stopServer(srv);
  }

  {
    const env = envFor({ CACHE_MAX: "10000", SERVER: "node" });
    const srv = await startServer(env);
    const reqs: Request[] = redirectReqs(
      Array.from({ length: 95 }, (_, i) => encode(1 + ((i * 613) % KEYSPACE)))
    );
    for (let i = 0; i < 5; i++) reqs.push(writeReq);
    await run("mixed 95/5 (w1)", Number(env.PORT), reqs);
    await stopServer(srv);
  }

  {
    const env = envFor({ CACHE_MAX: "10000", SERVER: "node" });
    const srv = await startServer(env);
    await run("shorten (write, w1)", Number(env.PORT), [writeReq]);
    await stopServer(srv);
  }

  // --- cluster scenarios (4 workers node:http, 2 client threads) ---
  {
    const env = envFor({ CACHE_MAX: "10000", WORKERS: "4", SERVER: "node" });
    const srv = await startServer(env);
    const codes = Array.from({ length: 100 }, (_, i) => encode(i + 1));
    for (const c of codes) {
      await fetch(`http://127.0.0.1:${env.PORT}/${c}`, { redirect: "manual" });
    }
    await run("redirect (node w4)", Number(env.PORT), redirectReqs(codes));
    await stopServer(srv);
  }

  // --- uWS scenarios (single process) ---
  {
    const env = envFor({ CACHE_MAX: "10000", SERVER: "uws" });
    const srv = await startServer(env);
    const codes = Array.from({ length: 100 }, (_, i) => encode(i + 1));
    for (const c of codes) {
      await fetch(`http://127.0.0.1:${env.PORT}/${c}`, { redirect: "manual" });
    }
    await run("redirect (uws)", Number(env.PORT), redirectReqs(codes));
    await run(
      "redirect (uws, p10)",
      Number(env.PORT),
      redirectReqs(codes),
      2,
      10
    );
    await stopServer(srv);
  }

  {
    const env = envFor({ CACHE_MAX: "10000", SERVER: "uws" });
    const srv = await startServer(env);
    const reqs: Request[] = redirectReqs(
      Array.from({ length: 95 }, (_, i) => encode(1 + ((i * 613) % KEYSPACE)))
    );
    for (let i = 0; i < 5; i++) reqs.push(writeReq);
    await run("mixed 95/5 (uws)", Number(env.PORT), reqs);
    await stopServer(srv);
  }

  {
    const env = envFor({ CACHE_MAX: "10000", SERVER: "uws" });
    const srv = await startServer(env);
    await run("shorten (uws)", Number(env.PORT), [writeReq]);
    await stopServer(srv);
  }
}

main();
