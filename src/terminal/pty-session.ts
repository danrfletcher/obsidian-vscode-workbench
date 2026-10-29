/**
 * One shell, run through the Python PTY helper. The plugin starts `python3 pty_helper.py`
 * and talks to it only over the helper's stdin and stdout pipes (pty-protocol.ts); there is
 * no socket. The helper is registered in the child registry, so quit, unload and the
 * orphan sweep take it (and the shell under it) down.
 */
import type { SpawnOptions } from "node:child_process";
import { spawn as realSpawn } from "node:child_process";
import type { ChildRegistry } from "../child-registry";
import { isAlive, listDescendants, signal } from "../process-utils";
import { FRAME_EXIT, FRAME_OUTPUT, FrameDecoder, ProtocolError, decodeExit, encodeInput, encodeResize } from "./pty-protocol";

/** The part of a child process the session uses (a fake in the unit tests). */
export interface ChildLike {
  pid?: number;
  stdin: { write(data: Buffer): unknown; end(): unknown; on(event: "error", cb: (e: Error) => void): unknown } | null;
  stdout: { on(event: "data", cb: (data: Buffer) => void): unknown } | null;
  stderr: { on(event: "data", cb: (data: Buffer) => void): unknown } | null;
  /** Fires once the process has ended and its pipes are closed, so every output byte has been read first. */
  on(event: "close", cb: (code: number | null, sig: string | null) => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildLike;

export interface SessionDeps {
  spawn: SpawnFn;
  registry?: ChildRegistry | null;
  signal: (pid: number, sig: NodeJS.Signals) => void;
  descendants: (pid: number) => number[];
  isAlive: (pid: number) => boolean;
}

export const realSessionDeps: SessionDeps = {
  spawn: realSpawn as unknown as SpawnFn,
  signal,
  descendants: listDescendants,
  isAlive,
};

export interface SessionOptions {
  python: string;
  helperPath: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
  /** Start the shell as a login shell, so it reads the user's profile (Obsidian itself has a bare PATH). */
  login: boolean;
}

export interface SessionExit {
  /** The shell's exit code (minus the signal number when a signal ended it); null when the helper stopped without reporting one. */
  code: number | null;
  /** The helper died or could not start, rather than the shell ending. */
  helperFailed: boolean;
  /** The last of the helper's own error output; empty when it said nothing. */
  detail: string;
}

/** The marker the orphan sweep looks for on a helper's command line. */
export const HELPER_MATCH = "pty_helper.py";

const STDERR_KEEP = 2000;
const KILL_GRACE_MS = 2000;

export class PtySession {
  private child: ChildLike | null = null;
  private decoder = new FrameDecoder();
  private outputListeners: Array<(data: Buffer) => void> = [];
  private exitListeners: Array<(exit: SessionExit) => void> = [];
  private stderrTail = "";
  private shellCode: number | null = null;
  private exited = false;
  private killing: Promise<void> | null = null;
  private unregister: (() => void) | null = null;
  private resolveExit: (() => void) | null = null;
  private exitSeen: Promise<void> = new Promise((r) => (this.resolveExit = r));

  constructor(
    private readonly opts: SessionOptions,
    private readonly deps: SessionDeps = realSessionDeps,
  ) {}

  /** The helper's pid; undefined before start or when it could not be spawned. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== null && !this.exited;
  }

  onOutput(cb: (data: Buffer) => void): void {
    this.outputListeners.push(cb);
  }

  onExit(cb: (exit: SessionExit) => void): void {
    this.exitListeners.push(cb);
  }

  start(): void {
    if (this.child) return;
    const { python, helperPath, shell, cwd, cols, rows, env, login } = this.opts;
    const args = [helperPath, "--cwd", cwd, "--shell", shell, "--rows", String(rows), "--cols", String(cols)];
    if (login) args.push("--login");
    const child = this.deps.spawn(python, args, { stdio: ["pipe", "pipe", "pipe"], env });
    this.child = child;
    child.stdin?.on("error", () => undefined); // a write after the helper went away
    child.stdout?.on("data", (data) => this.onData(data));
    child.stderr?.on("data", (data) => {
      this.stderrTail = (this.stderrTail + data.toString("utf8")).slice(-STDERR_KEEP);
    });
    child.on("error", (e) => {
      this.stderrTail = (this.stderrTail + e.message).slice(-STDERR_KEEP);
      this.finish(); // spawn failed: there is no exit event after this
    });
    child.on("close", () => this.finish());
    if (child.pid !== undefined && this.deps.registry) {
      this.unregister = this.deps.registry.register({
        pid: child.pid,
        label: "terminal-shell",
        match: HELPER_MATCH,
        workspace: cwd,
        kill: () => this.kill(),
      });
    }
  }

  /** Send keystrokes or pasted text to the shell. */
  write(data: string | Uint8Array): void {
    if (!this.running) return;
    const bytes = encodeInput(data);
    if (bytes.length) this.child?.stdin?.write(bytes);
  }

  /** Tell the shell its window is now `cols` x `rows`. */
  resize(cols: number, rows: number): void {
    if (!this.running) return;
    this.child?.stdin?.write(encodeResize({ cols, rows }));
  }

  /**
   * Stop the helper and the shell under it. The signals go out before the first await, so
   * plugin unload can call this and not wait. Resolves once the helper has exited.
   */
  kill(): Promise<void> {
    if (this.exited || !this.child) return Promise.resolve();
    if (this.killing) return this.killing;
    const pid = this.child.pid;
    if (pid === undefined) return Promise.resolve();
    // The tree is collected first: once the helper dies, whatever it left is re-parented.
    const tree = [pid, ...this.deps.descendants(pid)];
    this.child.stdin?.end(); // the helper reads the close as "the plugin is gone" and hangs the shell up itself
    for (const p of tree) this.deps.signal(p, "SIGTERM");
    this.killing = (async () => {
      await Promise.race([this.exitSeen, new Promise<void>((r) => setTimeout(r, KILL_GRACE_MS))]);
      for (const p of tree) if (this.deps.isAlive(p)) this.deps.signal(p, "SIGKILL");
      await Promise.race([this.exitSeen, new Promise<void>((r) => setTimeout(r, KILL_GRACE_MS))]);
      this.finish();
    })();
    return this.killing;
  }

  private onData(data: Buffer): void {
    let frames;
    try {
      frames = this.decoder.push(data);
    } catch (e) {
      if (e instanceof ProtocolError) {
        this.stderrTail = `the terminal helper sent bad data: ${e.message}`;
        void this.kill();
        return;
      }
      throw e;
    }
    for (const f of frames) {
      if (f.type === FRAME_OUTPUT) for (const cb of this.outputListeners) cb(f.payload);
      else if (f.type === FRAME_EXIT) {
        try {
          this.shellCode = decodeExit(f.payload);
        } catch {
          /* a malformed exit frame counts as no exit code */
        }
      }
    }
  }

  private finish(): void {
    if (this.exited) return;
    this.exited = true;
    this.unregister?.();
    this.unregister = null;
    this.resolveExit?.();
    const exit: SessionExit = { code: this.shellCode, helperFailed: this.shellCode === null, detail: this.stderrTail.trim() };
    for (const cb of this.exitListeners) cb(exit);
  }
}
