/**
 * Killing a shell asks first when the shell is running (G10). A shell that has already
 * exited, or never started, has nothing to lose, so it goes without a question. Cancel
 * and Escape both mean "keep it": `ask` resolves false for either.
 */
import type { SessionManager } from "./session-manager";

/** Ask whether to kill the shell named `title`. true only for an explicit confirm. */
export type AskKill = (title: string) => Promise<boolean>;

export type KillOutcome = "killed" | "kept" | "gone";

export class KillConfirm {
  /** Sessions with a question on screen: a second trash click on the same tab does not stack another. */
  private asking = new Set<string>();

  constructor(
    private readonly manager: SessionManager,
    private readonly ask: AskKill,
  ) {}

  /**
   * Kill session `id`: killed (and its tab removed), kept (the question was answered Cancel, or is
   * already open), or gone (no such session, e.g. it was removed while this call waited).
   */
  async request(id: string): Promise<KillOutcome> {
    const session = this.manager.get(id);
    if (!session) return "gone";
    if (session.controller.state.kind === "running") {
      if (this.asking.has(id)) return "kept";
      this.asking.add(id);
      let confirmed: boolean;
      try {
        confirmed = await this.ask(session.title);
      } finally {
        this.asking.delete(id);
      }
      if (!confirmed) return "kept";
      // The shell may have exited, or the tab been removed, while the question was open: remove() copes with both.
      if (!this.manager.get(id)) return "gone";
    }
    await this.manager.remove(id);
    return "killed";
  }
}
