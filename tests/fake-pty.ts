/** A fake helper process for the session and controller tests: no real python3 and no real shell. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ChildRegistry } from "../src/child-registry";
import type { ChildLike, SessionDeps } from "../src/terminal/pty-session";
import { FRAME_EXIT, FRAME_OUTPUT } from "../src/terminal/pty-protocol";

export class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  written: Buffer[] = [];
  stdinEnded = false;
  constructor(public pid: number) {
    super();
    this.stdin.on("data", (d: Buffer) => this.written.push(d));
    this.stdin.on("end", () => (this.stdinEnded = true));
  }
  /** What the plugin has sent so far, as one buffer. */
  sent(): Buffer {
    return Buffer.concat(this.written);
  }
  /** The helper sends shell output. */
  output(text: string | Buffer): void {
    this.stdout.write(frame(FRAME_OUTPUT, Buffer.from(text)));
  }
  /** The shell exits with `code`, then the helper process ends. */
  shellExit(code: number): void {
    const p = Buffer.alloc(4);
    p.writeInt32BE(code);
    this.stdout.write(frame(FRAME_EXIT, p));
    this.end();
  }
  /** The helper process ends (its pipes close). */
  end(): void {
    setImmediate(() => this.emit("close", 0, null));
  }
}

function frame(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

export interface FakeWorld {
  spawned: Array<{ command: string; args: string[]; child: FakeChild }>;
  signals: Array<[number, string]>;
  deps: SessionDeps;
  registry: ChildRegistry;
  /** Pids that count as alive until a SIGKILL or the child's end. */
  alive: Set<number>;
}

/** Fake `spawn`, with signals recorded instead of sent (a fake pid must never reach a real process). */
export function fakeWorld(opts: { descendants?: (pid: number) => number[]; diesOn?: "SIGTERM" | "SIGKILL" | "never" } = {}): FakeWorld {
  let next = 4000;
  const world: FakeWorld = {
    spawned: [],
    signals: [],
    registry: new ChildRegistry(null),
    alive: new Set(),
    deps: undefined as never,
  };
  world.deps = {
    spawn: (command, args) => {
      const child = new FakeChild(next++);
      world.spawned.push({ command, args, child });
      world.alive.add(child.pid);
      return child as unknown as ChildLike;
    },
    registry: world.registry,
    signal: (pid, sig) => {
      world.signals.push([pid, sig]);
      const dies = opts.diesOn ?? "SIGTERM";
      const target = world.spawned.find((s) => s.child.pid === pid)?.child;
      if (dies !== "never" && target && (sig === "SIGKILL" || dies === "SIGTERM")) {
        world.alive.delete(pid);
        target.end();
      }
    },
    descendants: opts.descendants ?? (() => []),
    isAlive: (pid) => world.alive.has(pid),
  };
  return world;
}
