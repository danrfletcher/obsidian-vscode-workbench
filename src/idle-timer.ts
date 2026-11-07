/**
 * The idle clock (G13). The server stops after IDLE_MS with no visible Code tab,
 * no dirty buffer and no live terminal shell. Any one of the three keeps it
 * alive and restarts the clock: the countdown starts again from zero the next
 * time all three are false.
 *
 * Idle stop never discards a dirty buffer (E13): a dirty buffer is a reason not
 * to stop, and it is re-checked at the moment the clock runs out. A live
 * terminal shell (G10) is checked the same way: it keeps the server up whether
 * the drawer is shown or hidden, and a read that fails counts as "cannot tell",
 * which also keeps it up.
 */
export const IDLE_MS = 5 * 60 * 1000;
export const IDLE_POLL_MS = 5_000;

export interface IdleDeps {
  /** True when at least one Code tab is on screen. */
  visibleCodeTab(): boolean;
  /** True when any Code tab holds an unsaved buffer (or this cannot be told). */
  hasDirtyBuffer(): boolean | Promise<boolean>;
  /**
   * True while any terminal shell lives under the server (an idle prompt or a running command; a hung shell counts until
   * it is closed; a shell whose process is gone does not). Never reads the drawer's visibility. A throw means "cannot tell".
   */
  liveTerminalShell(): boolean | Promise<boolean>;
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
  /**
   * True from the moment the clock runs out until the idle decision is made. While it is set, the countdown has already
   * been served in full, so whichever evaluation read the inputs last settles it (stops, or keeps the server up and
   * restarts the clock). A poll that lands during fire()'s re-check must not start a second countdown.
   */
  private firing = false;

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
    this.firing = false;
    this.seq++;
    this.clearTimer();
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
  }

  /**
   * Re-read the inputs. Call it when a Code tab appears, is hidden or closed, or when the terminal host page is created,
   * closed or changes state; the poller also calls it so that dirty buffers and shells coming and going (which raise no
   * event) are seen.
   */
  async evaluate(): Promise<void> {
    if (!this.running) return;
    const mine = ++this.seq;
    const keepAlive = await this.keepAlive();
    if (mine !== this.seq || !this.running) return; // a newer evaluation or stop() won
    if (keepAlive) {
      this.firing = false; // a fire() re-check that this evaluation superseded is settled: keep the server up
      this.clearTimer(); // cancelled mid-countdown; the clock restarts from zero later
    } else if (this.firing) {
      await this.goIdle(); // fire() was superseded by this read; the countdown is already served, so stop now
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.fire(), this.deps.idleMs ?? IDLE_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private async keepAlive(): Promise<boolean> {
    if (this.deps.visibleCodeTab()) return true;
    try {
      if (await this.deps.hasDirtyBuffer()) return true;
    } catch {
      return true; // cannot tell: never risk an unsaved buffer
    }
    try {
      return await this.deps.liveTerminalShell();
    } catch {
      return true; // cannot tell: never risk killing a shell (and what runs in it); the next poll asks again
    }
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (!this.running) return;
    this.firing = true;
    const mine = ++this.seq;
    // Re-check at the moment the clock runs out: a buffer may have turned dirty or a shell may have appeared since the last poll.
    if (await this.keepAlive()) {
      if (mine === this.seq && this.running) {
        this.firing = false;
        void this.evaluate();
      }
      return;
    }
    // A newer evaluation (poll or event) took over while we waited: it settles `firing` with a fresher read.
    if (mine !== this.seq || !this.running) return;
    await this.goIdle();
  }

  private async goIdle(): Promise<void> {
    this.firing = false;
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
