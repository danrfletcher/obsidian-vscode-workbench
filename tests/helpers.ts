import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach } from "vitest";

const dirs: string[] = [];

/** A fresh temp dir, removed after each test. */
export function tempDir(prefix = "vscode-workbench-test-"): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

export const FIXTURES = path.join(__dirname, "fixtures");
export const FAKE_CODE = path.join(FIXTURES, "fake-code.sh");
export const REPO_ROOT = path.join(__dirname, "..");

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** pids listening on a TCP port (via lsof); empty when none. */
export function listenersOn(port: number): number[] {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    return out.split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
