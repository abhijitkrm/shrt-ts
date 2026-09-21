// kv.ts — minimal RESP client (Redis / DragonflyDB / KeyDB) over node:net.
// A Kv is a bounded pool of sockets; each command checks one out, writes,
// awaits one reply, releases. Pipelines collapse N round-trips into one
// flush + one reply stream.

import * as net from "node:net";

export type Resp =
  | { kind: "simple" | "err"; str: string }
  | { kind: "int"; num: number }
  | { kind: "bulk"; str: Buffer | null }
  | { kind: "arr"; arr: Resp[] | null };

type Waiter = {
  want: number;          // replies this pipeline expects
  acc: Resp[];           // replies collected so far
  resolve: (r: Resp[]) => void;
  reject: (e: Error) => void;
};

class Conn {
  s: net.Socket;
  buf: Buffer = Buffer.alloc(0);
  queue: Waiter[] = [];
  dead = false;

  constructor(sock: net.Socket) {
    this.s = sock;
    sock.setNoDelay(true);
    sock.on("data", (d) => this.onData(d));
    sock.on("error", (e) => this.fail(e));
    sock.on("close", () => this.fail(new Error("kv: closed")));
  }

  fail(e: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const w of this.queue.splice(0)) w.reject(e);
  }

  onData(d: Buffer): void {
    this.buf = this.buf.length === 0 ? d : Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.queue.length === 0) return;
      const w = this.queue[0];
      const r = parse(this.buf);
      if (r === null) return; // need more bytes
      this.buf = this.buf.subarray(r.used);
      w.acc.push(r.resp);
      if (w.acc.length === w.want) {
        this.queue.shift();
        w.resolve(w.acc);
      }
    }
  }
}

function parse(buf: Buffer): { resp: Resp; used: number } | null {
  if (buf.length === 0) return null;
  const k = buf[0];
  switch (k) {
    case 0x2b: // +
    case 0x2d: { // -
      const p = buf.indexOf("\r\n", 1);
      if (p < 0) return null;
      return {
        resp: { kind: k === 0x2b ? "simple" : "err", str: buf.toString("utf8", 1, p) },
        used: p + 2,
      };
    }
    case 0x3a: { // :
      const p = buf.indexOf("\r\n", 1);
      if (p < 0) return null;
      return { resp: { kind: "int", num: Number(buf.toString("utf8", 1, p)) }, used: p + 2 };
    }
    case 0x24: { // $
      const p = buf.indexOf("\r\n", 1);
      if (p < 0) return null;
      const n = Number(buf.toString("utf8", 1, p));
      if (n < 0) return { resp: { kind: "bulk", str: null }, used: p + 2 };
      if (buf.length < p + 2 + n + 2) return null;
      return {
        resp: { kind: "bulk", str: buf.subarray(p + 2, p + 2 + n) },
        used: p + 2 + n + 2,
      };
    }
    case 0x2a: { // *
      const p = buf.indexOf("\r\n", 1);
      if (p < 0) return null;
      const n = Number(buf.toString("utf8", 1, p));
      if (n < 0) return { resp: { kind: "arr", arr: null }, used: p + 2 };
      let off = p + 2;
      const arr: Resp[] = [];
      for (let i = 0; i < n; i++) {
        const r = parse(buf.subarray(off));
        if (r === null) return null;
        arr.push(r.resp);
        off += r.used;
      }
      return { resp: { kind: "arr", arr }, used: off };
    }
  }
  return null;
}

function encode(args: (string | Buffer)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = typeof a === "string" ? Buffer.from(a) : a;
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from("\r\n"));
  }
  return Buffer.concat(parts);
}

export class Kv {
  private conns: Conn[] = [];
  private next = 0;

  private constructor(conns: Conn[]) {
    this.conns = conns;
  }

  static async connect(addr: string, nconn = 8): Promise<Kv> {
    const c = addr.lastIndexOf(":");
    const host = c < 0 ? addr : addr.slice(0, c);
    const port = c < 0 ? 6379 : Number(addr.slice(c + 1));
    const conns: Conn[] = [];
    for (let i = 0; i < nconn; i++) {
      const sock = await new Promise<net.Socket>((res, rej) => {
        const s = net.createConnection({ host, port }, () => res(s));
        s.once("error", rej);
      });
      conns.push(new Conn(sock));
    }
    const kv = new Kv(conns);
    const r = await kv.cmd("PING");
    if (r.kind !== "simple" || r.str !== "PONG") throw new Error("kv: PING failed");
    return kv;
  }

  private pick(): Conn {
    const c = this.conns[this.next++ % this.conns.length];
    if (c.dead) throw new Error("kv: conn dead");
    return c;
  }

  /** One command. */
  async cmd(...args: (string | Buffer)[]): Promise<Resp> {
    const rs = await this.pipe([args]);
    return rs[0];
  }

  /** N commands, one round-trip. */
  pipe(cmds: (string | Buffer)[][]): Promise<Resp[]> {
    const c = this.pick();
    const payload = Buffer.concat(cmds.map(encode));
    return new Promise<Resp[]>((resolve, reject) => {
      c.queue.push({ want: cmds.length, acc: [], resolve, reject });
      c.s.write(payload);
    });
  }

  // ---- typed helpers ----

  async get(key: string): Promise<Buffer | null> {
    const r = await this.cmd("GET", key);
    return r.kind === "bulk" ? r.str : null;
  }

  async set(key: string, val: string, pxMs: number, nx: boolean): Promise<boolean> {
    const args: string[] = ["SET", key, val];
    if (pxMs > 0) args.push("PX", String(pxMs));
    if (nx) args.push("NX");
    const r = await this.cmd(...args);
    return r.kind === "simple" && r.str === "OK";
  }

  async del(key: string): Promise<number> {
    const r = await this.cmd("DEL", key);
    return r.kind === "int" ? r.num : 0;
  }

  async incrbyMany(deltas: [string, number][]): Promise<void> {
    if (deltas.length === 0) return;
    await this.pipe(deltas.map(([k, d]) => ["INCRBY", k, String(d)]));
  }

  async scanEach(pat: string, cb: (key: string) => void): Promise<void> {
    let cursor = "0";
    for (;;) {
      const r = await this.cmd("SCAN", cursor, "MATCH", pat, "COUNT", "500");
      if (r.kind !== "arr" || !r.arr || r.arr.length !== 2) return;
      const cur = r.arr[0];
      cursor = cur.kind === "bulk" && cur.str ? cur.str.toString() : "0";
      const keys = r.arr[1];
      if (keys.kind === "arr" && keys.arr) {
        for (const k of keys.arr)
          if (k.kind === "bulk" && k.str) cb(k.str.toString());
      }
      if (cursor === "0") return;
    }
  }

  async flushdb(): Promise<void> {
    await this.cmd("FLUSHDB");
  }

  close(): void {
    for (const c of this.conns) c.s.destroy();
  }
}
