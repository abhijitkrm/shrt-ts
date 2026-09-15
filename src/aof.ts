import {
  openSync,
  appendFileSync,
  fsyncSync,
  closeSync,
  readSync,
  fstatSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

const NL = 10;

/** Append-only log: buffered line writes, batched fsync, replay, tailing. */
export class Aof {
  private fd: number;
  private queue: Buffer[] = [];
  private queued = 0;
  readonly path: string;

  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, name);
    this.fd = openSync(this.path, "a");
  }

  push(line: string): void {
    this.queue.push(Buffer.from(line + "\n"));
    this.queued += line.length + 1;
  }

  get pendingBytes(): number {
    return this.queued;
  }

  /** Append all queued lines in one write (page cache; fsync via sync()). */
  flush(): void {
    if (this.queue.length === 0) return;
    appendFileSync(this.fd, Buffer.concat(this.queue, this.queued));
    this.queue = [];
    this.queued = 0;
  }

  /** fsync the log file. */
  sync(): void {
    fsyncSync(this.fd);
  }

  size(): number {
    return fstatSync(this.fd).size;
  }

  /** Discard log contents (after a snapshot was written). */
  truncate(): void {
    this.flush();
    closeSync(this.fd);
    writeFileSync(this.path, "");
    this.fd = openSync(this.path, "a");
  }

  close(): void {
    this.flush();
    closeSync(this.fd);
  }
}

/** Read `path` and invoke cb for each complete JSON line (torn tail ignored). */
export function replayFile(path: string, cb: (obj: any) => void): void {
  if (!existsSync(path)) return;
  const buf = readFileSync(path);
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === NL) {
      if (i > start) {
        try {
          cb(JSON.parse(buf.subarray(start, i).toString()));
        } catch {
          // skip corrupt line
        }
      }
      start = i + 1;
    }
  }
}

/** Tracks a sibling log's read offset; readNew returns complete parsed lines. */
export class TailReader {
  private offset = 0;
  private leftover = Buffer.alloc(0);

  constructor(readonly path: string, fromStart = true) {
    this.offset = fromStart ? 0 : fileSize(path);
  }

  static fromStart(path: string): TailReader {
    return new TailReader(path, true);
  }

  readNew(cb: (obj: any) => void): void {
    const size = fileSize(this.path);
    if (size < this.offset) {
      // file was compacted/replaced: rescan current log (snapshot rows
      // were already merged, and row applies are idempotent)
      this.offset = 0;
      this.leftover = Buffer.alloc(0);
    }
    if (size <= this.offset) return;
    const fd = openSync(this.path, "r");
    let buf: Buffer;
    try {
      const len = size - this.offset;
      buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const data = this.leftover.length ? Buffer.concat([this.leftover, buf]) : buf;
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === NL) {
        if (i > start) {
          try {
            cb(JSON.parse(data.subarray(start, i).toString()));
          } catch {
            // skip corrupt line
          }
        }
        start = i + 1;
      }
    }
    this.leftover = Buffer.from(data.subarray(start));
  }

  close(): void {}
}

/** Claim the lowest free instance index via lock files; returns {id, release}. */
export function claimInstance(dir: string): { id: number; release: () => void } {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 1024; i++) {
    const lock = join(dir, `instance-${i}.lock`);
    let isMine = false;
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      isMine = true;
    } catch {
      // lock exists: steal it if the holder is dead
      try {
        const pid = Number(readFileSync(lock, "utf8").trim());
        process.kill(pid, 0); // throws if dead
      } catch {
        try {
          unlinkSync(lock);
          writeFileSync(lock, String(process.pid), { flag: "wx" });
          isMine = true;
        } catch {
          continue;
        }
      }
    }
    if (isMine) {
      return {
        id: i,
        release: () => {
          try {
            unlinkSync(lock);
          } catch {}
        },
      };
    }
  }
  throw new Error("no free instance id");
}

/** List shard log names present in dir (data-*.log), excluding `own`. */
export function shardFiles(dir: string, own: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(
    (f) => f.startsWith("data-") && f.endsWith(".log") && f !== own
  );
}

export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
