/**
 * Integration: the next-startup sweep (E11) with real processes. A "force-quit"
 * is simulated by starting the fake server detached, recording it in the pidfile
 * and then never stopping it: the next session's sweep must find and kill it,
 * and must leave an unrelated program alone even if the pidfile names its pid.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PidFile, sweepOrphans } from "../../src/pidfile";
import { findFreePort, httpStatus } from "../../src/server";
import { FAKE_CODE, isAlive, listenersOn, tempDir } from "../helpers";

const killed: number[] = [];
afterEach(() => {
  for (const pid of killed.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

async function startOrphanServer(dir: string, extraEnv: Record<string, string> = {}) {
  const port = await findFreePort();
  const tokenFile = path.join(dir, "connection-token");
  const token = "c".repeat(64);
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const serverPids = path.join(dir, "server-pids");
  const child = spawn(FAKE_CODE, ["serve-web", "--host", "127.0.0.1", "--port", String(port), "--connection-token-file", tokenFile], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: serverPids, ...extraEnv },
  });
  child.unref();
  const wrapper = child.pid as number;
  killed.push(wrapper);
  await vi.waitFor(async () => expect(await httpStatus(port, token)).toBe(302), { timeout: 8000, interval: 50 });
  const server = Number(fs.readFileSync(serverPids, "utf8").trim().split("\n")[0]);
  killed.push(server);
  return { port, wrapper, server, tokenFile };
}

describe("sweepOrphans with real processes", () => {
  it("kills a server left behind by a force-quit (wrapper, server and its port), then removes the pidfile", async () => {
    const dir = tempDir();
    const { port, wrapper, server } = await startOrphanServer(dir);
    const pf = new PidFile(path.join(dir, "pids.json"));
    pf.add({ pid: wrapper, label: "vscode-server", match: "serve-web", startedAt: Date.now(), workspace: dir, group: true });
    expect(listenersOn(port).length).toBeGreaterThan(0);

    // "next session starts": the previous plugin instance is gone, the server is not
    const result = await sweepOrphans(pf.file);

    expect(result.killed.map((e) => e.pid)).toEqual([wrapper]);
    await vi.waitFor(() => {
      expect(isAlive(wrapper)).toBe(false);
      expect(isAlive(server)).toBe(false);
      expect(listenersOn(port)).toEqual([]);
    }, { timeout: 5000 });
    expect(fs.existsSync(pf.file)).toBe(false);
  });

  it("leaves an unrelated live program alone when the pidfile names its (reused) pid, and still removes the pidfile", async () => {
    const dir = tempDir();
    const other = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
    other.unref();
    const otherPid = other.pid as number;
    killed.push(otherPid);
    const pf = new PidFile(path.join(dir, "pids.json"));
    pf.add({ pid: otherPid, label: "vscode-server", match: "serve-web", startedAt: 1, group: true });

    const result = await sweepOrphans(pf.file);

    expect(result.reused.map((e) => e.pid)).toEqual([otherPid]);
    expect(result.killed).toEqual([]);
    expect(isAlive(otherPid)).toBe(true);
    expect(fs.existsSync(pf.file)).toBe(false);
  });

  it("a pids.json from 0.1.0 that also lists PTY helpers: the server is taken down, a dead helper is dropped, a live pid that is not a helper is left alone", async () => {
    const dir = tempDir();
    const { port, wrapper, server } = await startOrphanServer(dir);
    const done = spawn("true");
    const deadHelper = done.pid as number;
    await new Promise((r) => done.once("exit", r));
    const other = spawn("sleep", ["301"], { stdio: "ignore", detached: true });
    other.unref();
    const otherPid = other.pid as number;
    killed.push(otherPid);
    const pf = new PidFile(path.join(dir, "pids.json"));
    pf.add({ pid: wrapper, label: "vscode-server", match: "serve-web", startedAt: Date.now(), workspace: dir, group: true });
    // the entries 0.1.0 wrote for a shell's helper: label "terminal-shell", marker "pty_helper.py"
    pf.add({ pid: deadHelper, label: "terminal-shell", match: "pty_helper.py", startedAt: 1, group: true });
    pf.add({ pid: otherPid, label: "terminal-shell", match: "pty_helper.py", startedAt: 1, group: true });

    const result = await sweepOrphans(pf.file);

    expect(result.killed.map((e) => e.pid)).toEqual([wrapper]);
    expect(result.gone.map((e) => e.pid)).toEqual([deadHelper]);
    expect(result.reused.map((e) => e.pid)).toEqual([otherPid]);
    await vi.waitFor(() => {
      expect(isAlive(wrapper)).toBe(false);
      expect(isAlive(server)).toBe(false);
      expect(listenersOn(port)).toEqual([]);
    }, { timeout: 5000 });
    expect(isAlive(otherPid)).toBe(true);
    expect(fs.existsSync(pf.file)).toBe(false);
  });

  it("a pidfile entry for a process that is already gone is dropped quietly", async () => {
    const dir = tempDir();
    const done = spawn("true");
    const pid = done.pid as number;
    await new Promise((r) => done.once("exit", r));
    const pf = new PidFile(path.join(dir, "pids.json"));
    pf.add({ pid, label: "vscode-server", match: "serve-web", startedAt: 1, group: true });
    const result = await sweepOrphans(pf.file);
    expect(result.gone.map((e) => e.pid)).toEqual([pid]);
    expect(fs.existsSync(pf.file)).toBe(false);
  });

  it("kills the server that outlived its wrapper (re-parented), found by this vault's token-file path", async () => {
    const dir = tempDir();
    const { port, wrapper, server } = await startOrphanServer(dir);
    const tokenFile = path.join(dir, "connection-token");
    const pf = new PidFile(path.join(dir, "pids.json"));
    pf.add({ pid: wrapper, label: "vscode-server", match: tokenFile, findByMatch: true, startedAt: Date.now(), workspace: dir, group: true });
    process.kill(wrapper, "SIGKILL"); // the wrapper dies; the server it started is re-parented and keeps listening
    await vi.waitFor(() => expect(isAlive(wrapper)).toBe(false), { timeout: 5000 });
    expect(isAlive(server)).toBe(true);
    expect(listenersOn(port).length).toBeGreaterThan(0);

    const result = await sweepOrphans(pf.file);

    expect(result.gone.map((e) => e.pid)).toEqual([wrapper]);
    expect(result.stragglers).toContain(server);
    await vi.waitFor(() => {
      expect(isAlive(server)).toBe(false);
      expect(listenersOn(port)).toEqual([]);
    }, { timeout: 5000 });
  });
});

// A terminal under the server (S6 of the terminal spike, docs/terminal-spike.md): the pty host starts each shell in its
// own session, so a shell and the dev server it runs are descendants of the server that carry neither "serve-web" nor
// the token-file path. The fake server starts such a shell (FAKE_CODE_SHELL_PORT).
const hasPython = spawnSync("python3", ["--version"]).status === 0;

async function answers(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
}

describe.skipIf(!hasPython)("sweepOrphans with a terminal under the server", () => {
  async function startWithShell(dir: string) {
    const devPort = await findFreePort();
    const shellPids = path.join(dir, "shell-pids");
    const srv = await startOrphanServer(dir, { FAKE_CODE_SHELL_PORT: String(devPort), FAKE_CODE_SHELL_PIDFILE: shellPids });
    const shell = Number(fs.readFileSync(shellPids, "utf8").trim().split("\n")[0]);
    killed.push(shell);
    await vi.waitFor(async () => expect(await answers(devPort)).toBe(true), { timeout: 8000, interval: 100 });
    // the dev server is the shell's child
    const child = spawnSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" }).stdout
      .split("\n")
      .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
      .find((m) => m && Number(m[2]) === shell && m[3].includes("http.server"));
    expect(child).toBeTruthy();
    const dev = Number(child?.[1]);
    killed.push(dev);
    return { ...srv, shell, dev, devPort };
  }

  it("finds and kills a detached shell and the http.server it runs, recorded under the server's match string", async () => {
    const dir = tempDir();
    const { wrapper, server, shell, dev, devPort, tokenFile } = await startWithShell(dir);
    // the shell is a separate process group and its command line shows neither marker: only the process tree reaches it
    const shellCommand = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(shell)], { encoding: "utf8" }).stdout;
    expect(shellCommand).not.toContain("serve-web");
    expect(shellCommand).not.toContain(tokenFile);
    const pf = new PidFile(path.join(dir, "pids.json"));
    pf.add({ pid: wrapper, label: "vscode-server", match: tokenFile, findByMatch: true, startedAt: Date.now(), workspace: dir, group: true });

    const result = await sweepOrphans(pf.file);

    expect(result.killed.map((e) => e.pid)).toEqual([wrapper]);
    await vi.waitFor(async () => {
      for (const pid of [wrapper, server, shell, dev]) expect(isAlive(pid)).toBe(false);
      expect(await answers(devPort)).toBe(false);
    }, { timeout: 5000 });
  });

  it("leaves a nohup process that nothing recorded alone, and removes the pidfile", async () => {
    const dir = tempDir();
    const { wrapper, shell, dev, tokenFile } = await startWithShell(dir);
    // a `nohup ... & disown`: detached, re-parented to init, not under the server, and nothing in the pidfile names it
    const nohup = spawn("nohup", ["sleep", "307"], { detached: true, stdio: "ignore" });
    nohup.unref();
    const nohupPid = nohup.pid as number;
    killed.push(nohupPid);
    const pf = new PidFile(path.join(dir, "pids.json"));
    pf.add({ pid: wrapper, label: "vscode-server", match: tokenFile, findByMatch: true, startedAt: Date.now(), workspace: dir, group: true });

    await sweepOrphans(pf.file);

    await vi.waitFor(() => {
      expect(isAlive(shell)).toBe(false);
      expect(isAlive(dev)).toBe(false);
    }, { timeout: 5000 });
    expect(isAlive(nohupPid)).toBe(true);
    expect(fs.existsSync(pf.file)).toBe(false);
  });
});
