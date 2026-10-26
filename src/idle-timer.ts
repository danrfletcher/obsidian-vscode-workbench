/**
 * The idle clock (G13). The server stops after IDLE_MS with no visible Code tab
 * and no dirty buffer. A visible Code tab or a dirty buffer keeps it alive and
 * restarts the clock: the countdown starts again from zero the next time both
 * are false.
 *
 * Idle stop never discards a dirty buffer (E13): a dirty buffer is a reason not
 * to stop, and it is re-checked at the moment the clock runs out.
 */
export const IDLE_MS = 5 * 60 * 1000;
export const IDLE_POLL_MS = 5_000;

export interface IdleDeps {
  /** True when at least one Code tab is on screen. */
  visibleCodeTab(): boolean;
  /** True when any Code tab holds an unsaved buffer (or this cannot be told). */
  hasDirtyBuffer(): boolean | Promise<boolean>;
  /** Called once when the clock runs out. */
  onIdle(): void | Promise<void>;
  idleMs?: number;
  pollMs?: number;
}

export class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private running = false;

  constructor(private readonly deps: IdleDeps) {}

  /** True while a countdown is running. */
  get counting(): boolean {
    return this.timer !== null;
  }

  /** Begin watching (call when the server is running). The clock starts now if nothing is keeping it alive. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const poll = this.deps.pollMs ?? IDLE_POLL_MS;
    this.poller = setInterval(() => void this.evaluate(), poll);
    (this.poller as { unref?: () => void }).unref?.();
    void this.evaluate();
  }

  /** Stop watching and cancel any countdown (call when the server is not running). */
  stop(): void {
    this.running = false;
    this.seq++;
    this.clearTimer();
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  /**
   * Re-read the inputs. Call it when a Code tab appears, is hidden or closed;
   * the poller also calls it so that dirty buffers (which raise no event) are seen.
   */
  async evaluate(): Promise<void> {
    if (!this.running) return;
    const mine = ++this.seq;
    const keepAlive = await this.keepAlive();
    if (mine !== this.seq || !this.running) return; // a newer evaluation or stop() won
    if (keepAlive) {
      this.clearTimer(); // cancelled mid-countdown; the clock restarts from zero later
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.fire(), this.deps.idleMs ?? IDLE_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private async keepAlive(): Promise<boolean> {
    if (this.deps.visibleCodeTab()) return true;
    try {
      return await this.deps.hasDirtyBuffer();
    } catch {
      return true; // cannot tell: never risk an unsaved buffer
    }
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (!this.running) return;
    const mine = ++this.seq;
    // Re-check at the moment the clock runs out: a buffer may have turned dirty since the last poll.
    if (await this.keepAlive()) {
      if (mine === this.seq && this.running) void this.evaluate();
      return;
    }
    if (mine !== this.seq || !this.running) return;
    this.running = false;
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    await this.deps.onIdle();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
