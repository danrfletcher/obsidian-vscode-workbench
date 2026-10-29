/**
 * Integration: the next-startup sweep (E11) with real processes. A "force-quit"
 * is simulated by starting the fake server detached, recording it in the pidfile
 * and then never stopping it: the next session's sweep must find and kill it,
 * and must leave an unrelated program alone even if the pidfile names its pid.
 */
import { spawn } from "node:child_process";
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

async function startOrphanServer(dir: string) {
  const port = await findFreePort();
  const tokenFile = path.join(dir, "connection-token");
  const token = "c".repeat(64);
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const serverPids = path.join(dir, "server-pids");
  const child = spawn(FAKE_CODE, ["serve-web", "--host", "127.0.0.1", "--port", String(port), "--connection-token-file", tokenFile], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: serverPids },
  });
  child.unref();
  const wrapper = child.pid as number;
  killed.push(wrapper);
  await vi.waitFor(async () => expect(await httpStatus(port, token)).toBe(302), { timeout: 8000, interval: 50 });
  const server = Number(fs.readFileSync(serverPids, "utf8").trim());
  killed.push(server);
  return { port, wrapper, server };
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
