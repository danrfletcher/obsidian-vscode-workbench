/**
 * The drawer's shell sessions (G10). Each session is one shell with its own controller
 * (preflight, the helper process, start folder), so tabs are independent: switching tabs
 * only changes which one is shown, and nothing here ever ends a shell except `remove()`
 * and `dispose()`.
 *
 * Sessions are added and removed synchronously. That is what makes a double click or a
 * double hotkey press on the first reveal create one shell, ten fast clicks on + create
 * ten, and a kill that races a natural exit remove the tab once: every decision reads the
 * list as it is at that moment, never a flag that is set later.
 */
import type { ShellController, ShellState } from "./terminal-controller";

export interface ManagedSession {
  /** Unique for the life of the manager and never reused after a kill: `shell-<n>`. */
  readonly id: string;
  /** The tab label: the shell's name and the number of the session. */
  readonly title: string;
  readonly controller: ShellController;
}

export type SessionEvent =
  | { type: "created"; session: ManagedSession }
  | { type: "activated"; id: string | null }
  | { type: "removed"; id: string }
  | { type: "state"; id: string; state: ShellState }
  | { type: "output"; id: string; data: Uint8Array }
  /** The number of running shells changed. */
  | { type: "count"; count: number }
  /** The last session was removed: the drawer closes. A shell exiting by itself never fires this. */
  | { type: "empty" };

export interface SessionManagerDeps {
  /** A new, unstarted controller for session `id`. */
  createController(id: string): ShellController;
  /** The shell's short name, for the tab label (`zsh`). */
  shellName(): string;
}

export class SessionManager {
  private list: ManagedSession[] = [];
  private active: string | null = null;
  private ordinal = 0;
  private lastCount = 0;
  private disposed = false;
  private listeners: Array<(e: SessionEvent) => void> = [];

  constructor(private readonly deps: SessionManagerDeps) {}

  get sessions(): readonly ManagedSession[] {
    return this.list;
  }

  get activeId(): string | null {
    return this.active;
  }

  get(id: string): ManagedSession | undefined {
    return this.list.find((s) => s.id === id);
  }

  /** The number of shells that are running now (a shell that exited, failed or is still starting is not counted). */
  get count(): number {
    return this.list.filter((s) => s.controller.state.kind === "running").length;
  }

  onEvent(cb: (e: SessionEvent) => void): void {
    this.listeners.push(cb);
  }

  /** Add a session, make it the active one and start its shell. */
  create(): ManagedSession | null {
    if (this.disposed) return null;
    this.ordinal += 1;
    const id = `shell-${this.ordinal}`;
    const controller = this.deps.createController(id);
    const session: ManagedSession = { id, title: `${this.deps.shellName()} ${this.ordinal}`, controller };
    this.list.push(session);
    // A session that has been removed no longer reports anything: its late output and its exit are dropped here.
    controller.onOutput((data) => {
      if (this.get(id)) this.emit({ type: "output", id, data });
    });
    controller.onState((state) => {
      if (!this.get(id)) return;
      this.emit({ type: "state", id, state });
      this.publishCount();
    });
    this.emit({ type: "created", session });
    this.activate(id);
    void controller.ensure();
    return session;
  }

  /** The first reveal: a shell only when there is none. Called twice in a row, it still makes one. */
  ensureFirst(): ManagedSession | null {
    if (this.disposed || this.list.length > 0) return null;
    return this.create();
  }

  activate(id: string): void {
    if (!this.get(id) || this.active === id) return;
    this.active = id;
    this.emit({ type: "activated", id });
  }

  /** Start the shell of `id` again after it exited or failed. */
  restart(id: string): Promise<void> {
    return this.get(id)?.controller.restart() ?? Promise.resolve();
  }

  /**
   * Take the session out and end its shell, with no question asked (kill-confirm.ts asks first).
   * The tab goes at once; the promise settles when the shell is gone. Removing a session that
   * is not there (it was removed already) does nothing.
   */
  remove(id: string): Promise<void> {
    const index = this.list.findIndex((s) => s.id === id);
    if (index < 0) return Promise.resolve();
    const [session] = this.list.splice(index, 1);
    const done = session.controller.dispose(); // the kill signals go out here, before anything else runs
    this.emit({ type: "removed", id });
    if (this.active === id) {
      const next = this.list[index] ?? this.list[index - 1] ?? null;
      this.active = next?.id ?? null;
      this.emit({ type: "activated", id: this.active });
    }
    this.publishCount();
    if (this.list.length === 0) this.emit({ type: "empty" });
    return done;
  }

  /** Quit and unload: every shell is signalled before this returns; the promise settles once they are gone. */
  dispose(): Promise<void> {
    this.disposed = true;
    const all = this.list.splice(0).map((s) => s.controller.dispose());
    this.active = null;
    this.listeners = [];
    return Promise.all(all).then(() => undefined);
  }

  private publishCount(): void {
    const count = this.count;
    if (count === this.lastCount) return;
    this.lastCount = count;
    this.emit({ type: "count", count });
  }

  private emit(e: SessionEvent): void {
    for (const cb of [...this.listeners]) cb(e);
  }
}
