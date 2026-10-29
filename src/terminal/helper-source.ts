/**
 * The PTY helper ships inside main.js (a plugin install has no other file to count on)
 * and is written next to the plugin's other runtime files before a shell starts, so
 * `python3` can run it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import helperSource from "./pty_helper.py";

export const HELPER_FILE = "pty_helper.py";

/** Write the helper into `dir` if it is missing or differs; returns its path. Throws if the folder cannot be written. */
export function installHelper(dir: string, source: string = helperSource): string {
  const file = path.join(dir, HELPER_FILE);
  let current: string | null = null;
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    /* not there yet */
  }
  if (current !== source) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, source, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return file;
}
