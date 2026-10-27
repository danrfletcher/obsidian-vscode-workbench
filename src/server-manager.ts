/**
 * The managed lifecycle of the one VS Code server (G13, G14):
 *
 *   stopped -> starting -> running -> stopped            (quit, manual stop)
 *                              |----> stopped-by-idle    (5 min, nothing visible, nothing dirty)
 *                              |----> crashed            (the process died on its own)
 *   starting -> failed                                   (start error: notice shown by the host)
 *
 * Start is single-flight: two Code tabs opening while the server starts share
 * one start. Every start asks for a fresh server (new token, and the vault's stable port when it is free, else a new port). A crash
 * is never restarted automatically: the banner in the tab asks the user, so a
 * server that keeps dying cannot loop.
 */
import { StartCancelledError, type RunningServer, type WorkbenchServer } from "./server";
import type { ChildRegistry } from "./child-registry";

export type ServerState = "stopped" | "starting" | "running" | "crashed" | "stopped-by-idle" | "failed";

export interface StartOptions {
  /** Start this cached server build instead of the installed build's (offline re-download fallback). */
  commitOverride?: string;
}

export interface ManagerOptions {
  /** Build a fresh WorkbenchServer (locates VS Code, test-starts serve-web). May throw a ServerStartError. */
  create(o: StartOptions): Promise<WorkbenchServer>;
  registry?: ChildRegistry;
  /** How often a running server is probed (ms). 0 turns the probe off; process exit is still noticed. */
  healthIntervalMs?: number;
  /** Consecutive failed probes before the server counts as crashed. */
  healthFailures?: number;
}

type Listener = (state: ServerState, previous: ServerState) => void;

export class ServerManager {
  private _state: ServerState = "stopped";
  private server: WorkbenchServer | null = null;
  private startPromise: Promise<RunningServer> | null = null;
  private generation = 0;
  private listeners = new Set<Listener>();
  private health: ReturnType<typeof setInterval> | null = null;
  private healthMisses = 0;
  private probing = false;
  /** The error of the last failed start (state "failed"). */
  lastError: unknown = null;

  constructor(private readonly opts: ManagerOptions) {}

  get state(): ServerState {
    return this._state;
  }

  get current(): RunningServer | null {
    return this._state === "running" ? (this.server?.current ?? null) : null;
  }

  /** The live server object (for its data dirs); null when none has been created. */
  get serverInstance(): WorkbenchServer | null {
    return this.server;
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setState(next: ServerState): void {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    for (const l of [...this.listeners]) l(next, prev);
  }

  /** The running server, starting it first if needed. Concurrent callers share one start. */
  ensureStarted(o: StartOptions = {}): Promise<RunningServer> {
    const running = this.current;
    if (running) return Promise.resolve(running);
    if (this.startPromise) return this.startPromise;
    const p: Promise<RunningServer> = this.doStart(o).finally(() => {
      if (this.startPromise === p) this.startPromise = null;
    });
    this.startPromise = p;
    return p;
  }

  private async doStart(o: StartOptions): Promise<RunningServer> {
    const gen = ++this.generation;
    this.lastError = null;
    this.setState("starting");
    const leftover = this.server;
    this.server = null;
    this.stopHealth();
    if (leftover) await leftover.stop(); // a crashed or idle-stopped server: clear anything it left behind
    let server: WorkbenchServer | null = null;
    try {
      server = await this.opts.create(o);
      if (gen !== this.generation) throw new StartCancelledError();
      this.server = server;
      server.onUnexpectedExit(() => this.handleCrash(server as WorkbenchServer, gen));
      const running = await server.ensureStarted();
      if (gen !== this.generation) {
        // stop() or restart() came in while we were starting; its stop of the old object may have run before the spawn.
        await server.stop();
        throw new StartCancelledError();
      }
      this.setState("running");
      this.startHealth(gen);
      return running;
    } catch (e) {
      if (server && this.server === server) this.server = null;
      if (server) await server.stop().catch(() => undefined);
      if (gen === this.generation && !(e instanceof StartCancelledError)) {
        this.lastError = e;
        this.setState("failed");
      }
      throw e;
    }
  }

  private handleCrash(server: WorkbenchServer, gen: number): void {
    if (this.server !== server || gen !== this.generation || this._state !== "running") return;
    this.stopHealth();
    this.setState("crashed");
    void server.stop(); // clear whatever the dead server left running
  }

  private startHealth(gen: number): void {
    const every = this.opts.healthIntervalMs ?? 5000;
    if (every <= 0) return;
    this.healthMisses = 0;
    this.health = setInterval(() => void this.checkHealth(gen), every);
    (this.health as { unref?: () => void }).unref?.();
  }

  private stopHealth(): void {
    if (this.health) clearInterval(this.health);
    this.health = null;
  }

  private async checkHealth(gen: number): Promise<void> {
    const server = this.server;
    if (this.probing || !server || gen !== this.generation || this._state !== "running") return;
    this.probing = true;
    try {
      const status = await server.probe();
      if (gen !== this.generation || this._state !== "running") return;
      this.healthMisses = status === null ? this.healthMisses + 1 : 0;
      if (this.healthMisses >= (this.opts.healthFailures ?? 2)) this.handleCrash(server, gen);
    } finally {
      this.probing = false;
    }
  }

  /**
   * Stop the server. `reason` decides the resting state: "idle" gives
   * stopped-by-idle, anything else gives stopped. Kill signals go out
   * synchronously, so quit and unload can call this without waiting.
   */
  stop(reason: "idle" | "quit" | "manual" = "manual"): Promise<void> {
    this.generation++;
    this.stopHealth();
    const server = this.server;
    this.server = null;
    const pending = server?.stop();
    this.startPromise = null;
    this.setState(reason === "idle" ? "stopped-by-idle" : "stopped");
    return pending ?? Promise.resolve();
  }

  /** Stop whatever is running (or crashed, or failed) and start a fresh server. Works from every state. */
  async restart(o: StartOptions = {}): Promise<RunningServer> {
    await this.stop("manual");
    return this.ensureStarted(o);
  }

  /** Quit: stop the server and kill every other registered child. */
  async shutdown(): Promise<void> {
    const stopped = this.stop("quit");
    await Promise.all([stopped, this.opts.registry?.killAll()]);
  }
}
