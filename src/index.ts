import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { Store } from "./store.js";
import { createApp } from "./app.js";
import { createUwsApp } from "./uws.js";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "urls.db";
const CACHE_MAX = Number(process.env.CACHE_MAX ?? 10_000);
const WORKERS = Number(process.env.WORKERS ?? 1);
const SEED = Number(process.env.SEED ?? 0);
const SERVER = process.env.SERVER ?? "uws";
const PORT_OFFSET = Number(process.env.PORT_OFFSET ?? 0);

function seed(path: string, n: number): void {
  const s = new Store(path, 0);
  if (s.isEmpty()) {
    const urls = new Array<string>(n);
    for (let i = 0; i < n; i++) urls[i] = `https://example.com/${i}`;
    s.seed(urls);
  }
  s.close();
}

function openStore(): Store {
  return new Store(DB_PATH, CACHE_MAX);
}

function shutdown(store: Store, closeServer?: () => void): void {
  const fn = () => {
    closeServer?.();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", fn);
  process.on("SIGTERM", fn);
}

function serve(): void {
  const store = openStore();
  if (SERVER === "uws") {
    const port = PORT + PORT_OFFSET; // uWS can't share a port across processes
    const app = createUwsApp(store);
    app.listen(port, (sock) => {
      if (!sock) {
        console.error(`failed to bind :${port}`);
        process.exit(1);
      }
      console.log(`uws listening on :${port} (pid ${process.pid})`);
    });
    shutdown(store);
    return;
  }
  const server = createApp(store);
  server.maxRequestsPerSocket = 0;
  server.listen(PORT, () => {
    console.log(`listening on :${PORT} (pid ${process.pid})`);
  });
  shutdown(store, () => server.close());
}

if (WORKERS > 1 && cluster.isPrimary) {
  if (SEED) seed(DB_PATH, SEED);
  // uWS workers can't share a socket: each gets PORT+i via PORT_OFFSET
  for (let i = 0; i < (WORKERS || availableParallelism()); i++) {
    cluster.fork({ PORT_OFFSET: i });
  }
} else {
  if (SEED) seed(DB_PATH, SEED);
  serve();
}
