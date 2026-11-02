/**
 * Integration: the fence through crash, restart, a failed restart and quit (F4, F6), with the real plugin, the real host page and the
 * fake `code` script.
 *
 *  F4  every URL the terminal page loads has host 127.0.0.1; the connection token is in the page URL only, never in message text,
 *      notices, logs or process arguments; and no connection leaves the machine.
 *  F6  desktop VS Code's `User` folders and its extensions folder (the fixture of `tests/fixtures/make-fake-instances.sh`) are
 *      byte-for-byte the same before and after.
 */
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal, Notice, Plugin, Tasks } from "../mocks/obsidian";
import VSCodeWorkbenchPlugin, { SPIKE_FILE } from "../../src/main";
import { FAKE_CODE, isAlive, tempDir } from "../helpers";
import { installFakeDocument, makeHostApp, type FakeDocument } from "../fake-host-page";

const MAKE_FAKE_INSTANCES = path.resolve(__dirname, "../fixtures/make-fake-instances.sh");

let tree: string;
let vault: string;
let pidFile: string;
let argsFile: string;
let plugin: VSCodeWorkbenchPlugin;
let doc: FakeDocument;
let connections: Array<{ host: string; port: number }>;
let logged: string[];
const tokens = new Set<string>();
const processArgs: string[] = [];

const inner = () => plugin as unknown as { manager: import("../../src/server-manager").ServerManager; data_: Record<string, unknown> };
const host = () => (plugin as unknown as { terminalHost: import("../../src/terminal-host/host-page").TerminalHostPage }).terminalHost;
const serverPids = () => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number) : []);
const until = (fn: () => void) => vi.waitFor(fn, { timeout: 8000, interval: 25 });

/** sha256 of every file under a directory, by relative path. */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) walk(f);
      else out[path.relative(dir, f)] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    }
  };
  walk(dir);
  return out;
}
const desktopState = () => ({ support: hashTree(path.join(tree, "AppSupport")), extensions: hashTree(path.join(tree, "Home/.vscode-insiders/extensions")) });

/** Remember the token of the server that is running now, and the arguments its processes were started with. */
function noteServer(): void {
  const current = inner().manager.current;
  if (current) tokens.add(current.token);
  for (const pid of serverPids()) if (isAlive(pid)) processArgs.push(execFileSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }));
  const wrapper = inner().manager.serverInstance?.pid;
  if (wrapper && isAlive(wrapper)) processArgs.push(execFileSync("ps", ["-ww", "-o", "args=", "-p", String(wrapper)], { encoding: "utf8" }));
}

beforeEach(() => {
  tree = path.join(tempDir(), "fake");
  execFileSync(MAKE_FAKE_INSTANCES, [tree]);
  vault = tempDir();
  fs.mkdirSync(path.join(vault, path.dirname(SPIKE_FILE)), { recursive: true });
  fs.writeFileSync(path.join(vault, SPIKE_FILE), "import os\n");
  pidFile = path.join(tempDir(), "pids");
  argsFile = path.join(tempDir(), "args.json");
  Plugin.reset();
  Notice.reset();
  Modal.reset();
  tokens.clear();
  processArgs.length = 0;
  connections = [];
  logged = [];
  const connect = net.Socket.prototype.connect;
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    // Node's own callers pass the normalised arguments as one array: [options, callback]
    const first = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { host?: string; port?: number } | number | string;
    if (typeof first === "object" && first !== null && "port" in first) connections.push({ host: String(first.host ?? "localhost"), port: Number(first.port) });
    else if (typeof first === "number") connections.push({ host: typeof args[1] === "string" ? args[1] : "localhost", port: first });
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as never);
  for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  doc = installFakeDocument();
});

afterEach(async () => {
  plugin?.onunload();
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of serverPids()) if (isAlive(pid)) process.kill(pid, "SIGKILL");
  for (const k of ["FAKE_CODE_NODE", "FAKE_CODE_PIDFILE", "FAKE_CODE_ARGSFILE", "WORKBENCH_APP_SUPPORT_ROOT"]) delete process.env[k];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load(): Promise<void> {
  Object.assign(process.env, { FAKE_CODE_NODE: process.execPath, FAKE_CODE_PIDFILE: pidFile, FAKE_CODE_ARGSFILE: argsFile, WORKBENCH_APP_SUPPORT_ROOT: path.join(tree, "AppSupport") });
  plugin = new VSCodeWorkbenchPlugin(makeHostApp(vault) as never, { id: "obsidian-vscode-workbench", dir: ".obsidian/plugins/obsidian-vscode-workbench" } as never);
  (plugin as unknown as { pluginData: unknown }).pluginData = { codeCliPath: FAKE_CODE, embed: "iframe", serverLicenceAccepted: true };
  (plugin as unknown as { downloadHostReachable: () => Promise<boolean> }).downloadHostReachable = async () => false;
  await plugin.onload();
}

/** Start, crash, restart from the banner, fail a restart, restart again, then quit: the whole story. */
async function story(): Promise<void> {
  plugin.showTerminalHost();
  await host().settled();
  noteServer();

  process.kill(serverPids()[serverPids().length - 1], "SIGKILL");
  await until(() => expect(inner().manager.state).toBe("crashed"));
  inner().data_.codeCliPath = path.join(vault, "no-such-code");
  doc.button("Restart")!.click(); // fails
  await until(() => expect(inner().manager.state).toBe("failed"));
  await until(() => expect(doc.text()).toContain("could not be restarted"));

  inner().data_.codeCliPath = FAKE_CODE;
  doc.button("Restart")!.click();
  await until(() => expect(host().view()).toBe("lost"));
  noteServer();
  await plugin.restartServer(); // from the settings button, no prompt
  await until(() => expect(host().view()).toBe("lost"));
  noteServer();

  const tasks = new Tasks();
  for (const e of Plugin.events.filter((x) => x.name === "quit")) e.cb(tasks);
  await tasks.runAll();
}

describe("F4 through crash, restart, a failed restart and quit", () => {
  it("every URL the terminal page loads is on 127.0.0.1", async () => {
    await load();
    await story();
    expect(doc.webviews.length).toBeGreaterThanOrEqual(3);
    for (const wv of doc.webviews) {
      expect(wv.srcs.length).toBeGreaterThan(0);
      for (const src of wv.srcs) expect(new URL(src).hostname).toBe("127.0.0.1");
    }
  });

  it("the token appears only in the page URL: not in text, notices, logs or process arguments", async () => {
    await load();
    await story();
    expect(tokens.size).toBeGreaterThanOrEqual(3);
    const everywhereElse = [doc.text(), ...Notice.messages, ...logged, ...processArgs, fs.existsSync(argsFile) ? fs.readFileSync(argsFile, "utf8") : ""].join("\n");
    for (const t of tokens) expect(everywhereElse).not.toContain(t);
    // and it is in the page URL: the final src of each page that got as far as loading the workbench carries one
    const withToken = doc.webviews.filter((wv) => [...tokens].some((t) => wv.srcs[wv.srcs.length - 1].includes(t)));
    expect(withToken.length).toBeGreaterThanOrEqual(3);
    for (const wv of doc.webviews) for (const src of wv.srcs.slice(0, -1)) for (const t of tokens) expect(src).not.toContain(t); // the seeding origin is bare
  });

  it("no connection is opened to anything but 127.0.0.1", async () => {
    await load();
    await story();
    expect(connections.length).toBeGreaterThan(0); // the spy sees the plugin's own health and readiness probes
    for (const c of connections) expect(["127.0.0.1", "localhost", "::1"]).toContain(c.host);
  });
});

describe("F6 desktop VS Code's folders", () => {
  it("are byte-for-byte the same after crash, restart, a failed restart and quit", async () => {
    const before = desktopState();
    expect(Object.keys(before.support).length).toBeGreaterThan(0);
    expect(Object.keys(before.extensions).length).toBeGreaterThan(0);
    await load();
    await story();
    expect(desktopState()).toEqual(before);
  });

  it("the terminal page's own profile is under the plugin's .server folder", async () => {
    await load();
    plugin.showTerminalHost();
    await host().settled();
    const server = path.join(vault, ".obsidian/plugins/obsidian-vscode-workbench/.server");
    expect(fs.existsSync(server)).toBe(true);
    expect(JSON.parse(fs.readFileSync(argsFile, "utf8")).join(" ")).toContain(server);
  });
});
