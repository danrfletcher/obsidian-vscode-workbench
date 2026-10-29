/**
 * The VS Code server licence step. Nothing is downloaded from Microsoft until
 * the user has accepted the server licence terms at the first Code-tab open.
 * Declining (the Decline button, Escape, or clicking away) leaves the flag
 * false: nothing downloads, no server starts, and the next explicit open asks
 * again. The flag lives in the plugin's data.json and survives a reload.
 */

/** Where the licence terms are published. Shown to the user; the plugin never fetches it. */
export const SERVER_LICENCE_URL = "https://aka.ms/vscode-server-license";

export interface LicenceStore {
  accepted(): boolean;
  setAccepted(value: boolean): Promise<void>;
}

/** Thrown when a Code tab cannot open because the licence was declined. */
export class LicenceDeclinedError extends Error {
  constructor() {
    super("The VS Code server licence was declined.");
    this.name = "LicenceDeclinedError";
  }
}

export class LicenceGate {
  private pending: Promise<boolean> | null = null;

  /**
   * @param prompt shows the licence modal; resolves true only for an explicit Accept
   */
  constructor(
    private readonly store: LicenceStore,
    private readonly prompt: () => Promise<boolean>,
  ) {}

  get accepted(): boolean {
    return this.store.accepted();
  }

  /**
   * Resolve true when the licence is (now) accepted. Callers that arrive while
   * the modal is open share it: one prompt, one answer.
   */
  request(): Promise<boolean> {
    if (this.store.accepted()) return Promise.resolve(true);
    if (this.pending) return this.pending;
    const p = (async () => {
      const accepted = await this.prompt();
      if (accepted) await this.store.setAccepted(true);
      return accepted;
    })().finally(() => {
      if (this.pending === p) this.pending = null;
    });
    this.pending = p;
    return p;
  }
}
