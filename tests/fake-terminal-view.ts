import type { TerminalView } from "../src/terminal/drawer-ui";

/** A terminal emulator stand-in: records what the drawer does to it. */
export class FakeTerminalView implements TerminalView {
  written: string[] = [];
  fits = 0;
  resets = 0;
  focuses = 0;
  themes = 0;
  disposed = false;
  cells = { cols: 80, rows: 24 };
  private input: Array<(d: string) => void> = [];
  private resize: Array<(c: number, r: number) => void> = [];
  private toggle: Array<() => void> = [];

  write(data: Uint8Array | string): void {
    this.written.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  }
  onInput(cb: (d: string) => void): void {
    this.input.push(cb);
  }
  onResize(cb: (c: number, r: number) => void): void {
    this.resize.push(cb);
  }
  onToggleKey(cb: () => void): void {
    this.toggle.push(cb);
  }
  fit(): void {
    this.fits += 1;
  }
  size(): { cols: number; rows: number } {
    return this.cells;
  }
  focus(): void {
    this.focuses += 1;
  }
  reset(): void {
    this.resets += 1;
    this.written = [];
  }
  refreshTheme(): void {
    this.themes += 1;
  }
  dispose(): void {
    this.disposed = true;
  }

  /** The user types into the terminal. */
  type(data: string): void {
    for (const cb of this.input) cb(data);
  }
  /** The terminal's cell grid changes (a fit found a new size). */
  setCells(cols: number, rows: number): void {
    this.cells = { cols, rows };
    for (const cb of this.resize) cb(cols, rows);
  }
  pressToggleKey(): void {
    for (const cb of this.toggle) cb();
  }
  text(): string {
    return this.written.join("");
  }
}
