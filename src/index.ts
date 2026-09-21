import cluster from "node:cluster";
import { availableParallelism } from "node:os";
import { openStore } from "./openstore.js";
import type { StoreApi } from "./storeapi.js";
import { createApp } from "./app.js";
import { createUwsApp } from "./uws.js";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? "data";
const WORKERS = Number(process.env.WORKERS ?? 1);
const SEED = Number(process.env.SEED ?? 0);
const SERVER = process.env.SERVER ?? "uws";
const PORT_OFFSET = Number(process.env.PORT_OFFSET ?? 0);
const INSTANCE = process.env.INSTANCE;

async function seed(): Promise<void> {
  const s = await openStore(DATA_DIR);
  if (await s.isEmpty()) {
    const urls = new Array<string>(SEED);
    for (let i = 0; i < SEED; i++) urls[i] = `https://example.com/${i}`;
    await s.seed(urls);
  }
  s.close();
}

async function serve(): Promise<void> {
  const store = await openStore(
    DATA_DIR,
    INSTANCE !== undefined ? Number(INSTANCE) : undefined
  );
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

function shutdown(store: StoreApi, closeServer?: () => void): void {
  const fn = () => {
    closeServer?.();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", fn);
  process.on("SIGTERM", fn);
}

if (WORKERS > 1 && cluster.isPrimary) {
  if (SEED) seed();
  // uWS workers can't share a socket: each binds PORT+i via PORT_OFFSET
  for (let i = 0; i < (WORKERS || availableParallelism()); i++) {
    cluster.fork({ PORT_OFFSET: i });
  }
} else {
  if (SEED) seed();
  serve();
}
