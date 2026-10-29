/**
 * A generic registry of child processes the plugin owns. The VS Code server
 * registers itself here; the terminal PRs register their shells and PTY helpers.
 * `killAll()` is what quit calls, and every registration is mirrored into the
 * pidfile so a force-quit leaves a record for the next startup's sweep.
 */
import { PidFile } from "./pidfile";

export interface RegisteredChild {
  pid: number;
  label: string;
  /** Substring of the command line the orphan sweep requires before it kills this pid. */
  match: string;
  workspace?: string;
  group?: boolean;
  /** `match` is unique to this program (see PidEntry.findByMatch): the sweep also hunts down its children by it. */
  findByMatch?: boolean;
  /**
   * Stop this child and everything under it. Signals should go out
   * synchronously (before the first await); the promise settles once it is gone.
   */
  kill(): Promise<void> | void;
}

export class ChildRegistry {
  private children = new Map<number, RegisteredChild>();

  constructor(private readonly pidfile: PidFile | null = null) {}

  /** Register a child. Returns a function that unregisters it (call when it exits). */
  register(child: RegisteredChild): () => void {
    this.children.set(child.pid, child);
    this.pidfile?.add({
      pid: child.pid,
      label: child.label,
      match: child.match,
      startedAt: Date.now(),
      workspace: child.workspace,
      group: child.group,
      findByMatch: child.findByMatch,
    });
    return () => this.unregister(child.pid);
  }

  unregister(pid: number): void {
    if (!this.children.delete(pid)) return;
    this.pidfile?.removePid(pid);
  }

  get size(): number {
    return this.children.size;
  }

  list(): Array<Pick<RegisteredChild, "pid" | "label">> {
    return [...this.children.values()].map((c) => ({ pid: c.pid, label: c.label }));
  }

  /** Kill every registered child. All kill signals are issued before any wait. */
  async killAll(): Promise<void> {
    const all = [...this.children.values()];
    const pending: Array<Promise<void> | void> = [];
    for (const c of all) {
      try {
        pending.push(c.kill());
      } catch {
        /* keep killing the rest */
      }
    }
    await Promise.allSettled(pending);
    for (const c of all) this.unregister(c.pid);
  }
}
