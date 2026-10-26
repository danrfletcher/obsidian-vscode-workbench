/**
 * One shell session of the drawer: when it starts, what state it is in, and how it ends.
 * The session manager makes one controller per tab (session-manager.ts); hiding and
 * revealing the drawer keep the same live shell, and a shell that exited, or one that could
 * not start (E9, E10), is started afresh by the restart control. Starting is single-flight,
 * so two `ensure()` calls in a row create exactly one shell.
 */
import type { PreflightResult } from "./pty-preflight";
import { PtySession, type SessionExit, type SessionOptions } from "./pty-session";
import type { ShellStartDir } from "./shell-cwd";

export type ShellState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "exited"; code: number | null }
  | { kind: "failed"; message: string };

export interface ControllerDeps {
  /** The shell the settings ask for (a path, or "" for the default is already resolved by the caller). */
  shell(): string;
  preflight(shell: string): Promise<PreflightResult>;
  /** Write the helper script where python3 can run it; returns its path. May throw. */
  installHelper(): string;
  startDir: ShellStartDir;
  /** The terminal's current size; the shell starts with it. */
  size(): { cols: number; rows: number };
  env(): NodeJS.ProcessEnv;
  createSession(opts: SessionOptions): PtySession;
}

export class ShellController {
  private current: PtySession | null = null;
  private starting: Promise<void> | null = null;
  private disposed = false;
  private stateValue: ShellState = { kind: "idle" };
  private stateListeners: Array<(s: ShellState) => void> = [];
  private outputListeners: Array<(data: Uint8Array) => void> = [];
  /** How many shells this controller has created (the tests and the status bar read it). */
  created = 0;

  constructor(private readonly deps: ControllerDeps) {}

  get state(): ShellState {
    return this.stateValue;
  }

  /** The number of live shells this controller runs: 0 or 1. */
  get liveCount(): number {
    return this.current?.running ? 1 : 0;
  }

  onState(cb: (s: ShellState) => void): void {
    this.stateListeners.push(cb);
  }

  onOutput(cb: (data: Uint8Array) => void): void {
    this.outputListeners.push(cb);
  }

  /**
   * Make sure there is a live shell: nothing happens while one runs or is starting; an
   * idle, exited or failed state starts a new one. Resolves when the start has finished,
   * whatever its outcome (read `state`).
   */
  ensure(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.starting) return this.starting;
    if (this.stateValue.kind === "running") return Promise.resolve();
    const p = this.start().finally(() => {
      if (this.starting === p) this.starting = null;
    });
    this.starting = p;
    return p;
  }

  /** Kill the running shell (if any) and start a new one. */
  async restart(): Promise<void> {
    const old = this.current;
    this.current = null;
    if (old) await old.kill();
    if (this.starting) await this.starting;
    this.deps.startDir.release();
    this.setState({ kind: "idle" });
    await this.ensure();
  }

  write(data: string | Uint8Array): void {
    this.current?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.current?.resize(cols, rows);
  }

  /** Stop for good (unload, quit): the signals are sent before this returns; the promise settles when the helper is gone. */
  dispose(): Promise<void> {
    this.disposed = true;
    const s = this.current;
    this.current = null;
    return s ? s.kill() : Promise.resolve();
  }

  private setState(s: ShellState): void {
    this.stateValue = s;
    for (const cb of this.stateListeners) cb(s);
  }

  private async start(): Promise<void> {
    this.setState({ kind: "starting" });
    const cwd = this.deps.startDir.pin();
    const checked = await this.deps.preflight(this.deps.shell());
    if (this.disposed) return;
    if (!checked.ok) {
      this.deps.startDir.release();
      this.setState({ kind: "failed", message: checked.message });
      return;
    }
    let helperPath: string;
    try {
      helperPath = this.deps.installHelper();
    } catch (e) {
      this.deps.startDir.release();
      this.setState({ kind: "failed", message: `The terminal helper could not be written (${e instanceof Error ? e.message : String(e)}), so the terminal cannot start. Check that the plugin folder is writable, then reveal the terminal again.` });
      return;
    }
    const { cols, rows } = this.deps.size();
    const session = this.deps.createSession({
      python: checked.python,
      helperPath,
      shell: checked.shell,
      cwd,
      cols,
      rows,
      env: this.deps.env(),
      login: true,
    });
    this.created += 1;
    this.current = session;
    session.onOutput((data) => {
      if (this.current === session) for (const cb of this.outputListeners) cb(data);
    });
    session.onExit((exit) => this.onSessionExit(session, exit));
    session.start();
    this.setState({ kind: "running" });
  }

  private onSessionExit(session: PtySession, exit: SessionExit): void {
    if (this.current !== session) return; // killed on purpose (restart, dispose)
    this.current = null;
    this.deps.startDir.release();
    if (exit.helperFailed) {
      const why = exit.detail ? `: ${exit.detail}` : "";
      this.setState({ kind: "failed", message: `The terminal helper stopped unexpectedly${why}. Reveal the terminal again to restart it.` });
    } else {
      this.setState({ kind: "exited", code: exit.code });
    }
  }
}
