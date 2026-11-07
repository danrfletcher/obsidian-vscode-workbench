/**
 * Saves the drawer's height in the plugin's `data.json` under this device's id (G3). A drag or a window resize can change the
 * height many times a second, so the data object is updated at once and the file is written a moment after the last change.
 * `flush` writes what is still waiting (on unload).
 */
import { readDrawerState, withDrawerState } from "./drawer-state";

/** How long the file write waits after the last change, in ms. */
export const SAVE_DEBOUNCE_MS = 400;

export interface HeightStoreOptions {
  /** The plugin's live data object (what `saveData` writes). */
  data(): Record<string, unknown>;
  save(): Promise<void>;
  deviceId: string;
  windowHeight(): number;
  debounceMs?: number;
}

export class HeightStore {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: HeightStoreOptions) {}

  /** This device's saved height, clamped to the window; the default height when none is saved or the value is corrupt. */
  read(): number {
    return readDrawerState(this.opts.data(), this.opts.deviceId, this.opts.windowHeight()).height;
  }

  /** Record the height now and write the file shortly. */
  write(height: number): void {
    const data = this.opts.data();
    Object.assign(data, withDrawerState(data, this.opts.deviceId, { height, open: false }));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.opts.debounceMs ?? SAVE_DEBOUNCE_MS);
  }

  /** Write the file now if a write is waiting. */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.opts.save().catch((e: unknown) => console.warn("VS Code Workbench: could not save the terminal drawer height:", e instanceof Error ? e.message : e));
  }
}
