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

/** Every .ts file under a directory (recursively), as paths relative to it with `/` separators, sorted. */
export function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, prefix: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
      else if (e.name.endsWith(".ts")) out.push(`${prefix}${e.name}`);
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * A webview stand-in with a scripted `executeJavaScript`: it fires `dom-ready` once, after the first `src` is set
 * (a webview does when its page has loaded), and answers the settings seed with `executeResult` and the trust seed
 * (told apart by the database it opens) with `trustResult`. `executed` lists every script it was given, in order.
 */
export class FakeWebview {
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeWebview[] = [];
  text = "";
  /** Every value `src` has been set to, in order. */
  srcs: string[] = [];
  executed: string[] = [];
  autoDomReady = true;
  executeResult: () => Promise<unknown> = async () => "seeded";
  trustResult: () => Promise<unknown> = async () => "seeded";
  private listeners: Record<string, (() => void)[]> = {};
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    if (k === "src") {
      this.srcs.push(v);
      if (this.srcs.length === 1 && this.autoDomReady) setTimeout(() => this.fire("dom-ready"), 0);
    }
  }
  addEventListener(name: string, fn: () => void) {
    (this.listeners[name] ??= []).push(fn);
  }
  fire(name: string) {
    for (const fn of this.listeners[name]?.splice(0) ?? []) fn();
  }
  executeJavaScript(code: string) {
    this.executed.push(code);
    return code.includes("vscode-web-state-db-global-shared") ? this.trustResult() : this.executeResult();
  }
  appendChild(c: FakeWebview) {
    this.children.push(c);
  }
  addClass() {}
  empty() {
    this.children = [];
    this.text = "";
  }
  createDiv(o: { text: string }) {
    this.text = o.text;
  }
  remove() {}
}
