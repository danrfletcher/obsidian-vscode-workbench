/**
 * Integration: the real scan and the real probe over real temp dirs with
 * shell-script fake CLIs (one passes, one exits 1, one hangs, one prints
 * nothing, one runs a missing helper). Nothing is mocked: the probe is the
 * production one. F3: a hash of the fixture tree taken before and after the
 * scan, the probe, the choice and the copy is identical, with the tree made
 * read-only so any write, rename, delete or chmod would fail.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chooseInstance } from "../../src/instances/choose";
import { PROBE_TIMEOUT_MS } from "../../src/instances/probe";
import { SCAN_TIMEOUT_MS, scanInstances } from "../../src/instances/scan";
import { instanceUserDir, seedUserData } from "../../src/server/user-data-seed";
import { EXIT1_SCRIPT, HANG_SCRIPT, MISSING_HELPER_SCRIPT, NO_MENTION_SCRIPT, PASS_SCRIPT, SILENT_SCRIPT, makeApp, makeReadOnly, makeWritable, treeDigest } from "../instance-helpers";
import { isAlive, tempDir } from "../helpers";

const writable: string[] = [];
afterEach(() => {
  for (const d of writable.splice(0)) makeWritable(d);
});

/** Both fixture folders under one temp dir: `Applications` (scan root) and `Application Support`. */
function fixture() {
  const base = tempDir();
  const apps = path.join(base, "Applications");
  const support = path.join(base, "Application Support");
  fs.mkdirSync(apps);
  fs.mkdirSync(support);
  writable.push(base);
  return { base, apps, support };
}

describe("the real scan over fake CLIs", () => {
  it("lists the one that passes and rejects exit 1, silent, no-mention and a missing helper, each with its reason", async () => {
    const { apps } = fixture();
    makeApp(apps, { name: "Visual Studio Code.app", bundleId: "com.microsoft.VSCode", version: "1.143.1", cli: "code", script: PASS_SCRIPT });
    makeApp(apps, { name: "VSCodium.app", bundleId: "com.vscodium", version: "1.140.0", cli: "codium", script: EXIT1_SCRIPT });
    makeApp(apps, { name: "Antigravity.app", bundleId: "com.google.antigravity", version: "1.2.0", cli: "antigravity", script: SILENT_SCRIPT });
    makeApp(apps, { name: "Visual Studio Code - Insiders.app", bundleId: "com.microsoft.VSCodeInsiders", version: "1.144.0-insider", cli: "code", script: NO_MENTION_SCRIPT });
    makeApp(apps, { name: "Antigravity IDE.app", bundleId: "com.google.antigravity-ide", version: "1.3.0", cli: "antigravity-ide", script: MISSING_HELPER_SCRIPT });
    const r = await scanInstances({ roots: [apps] });
    expect(r.instances.map((i) => i.label)).toEqual(["VS Code 1.143.1"]);
    const reason = (labelStart: string) => r.rejected.find((x) => x.label.startsWith(labelStart))?.reason ?? "";
    expect(r.rejected).toHaveLength(4);
    expect(reason("VSCodium")).toMatch(/exited with code 1/);
    expect(reason("Antigravity 1")).toMatch(/no "serve-web" command/);
    expect(reason("VS Code Insiders")).toMatch(/no "serve-web" command/);
    expect(reason("Antigravity IDE")).toMatch(/exited with code 12[67]/); // sh reports a helper it cannot run as 126 or 127
  });

  it("a script that hangs is killed at the probe timeout and counts as failed; the whole scan ends well inside 10 s", async () => {
    const { apps, base } = fixture();
    const pidfile = path.join(base, "hang.pid");
    process.env.HANG_PIDFILE = pidfile;
    try {
      makeApp(apps, { name: "Visual Studio Code.app", bundleId: "com.microsoft.VSCode", version: "1.143.1", cli: "code", script: PASS_SCRIPT });
      makeApp(apps, { name: "VSCodium.app", bundleId: "com.vscodium", version: "1.140.0", cli: "codium", script: HANG_SCRIPT });
      const started = Date.now();
      const r = await scanInstances({ roots: [apps] });
      const took = Date.now() - started;
      expect(PROBE_TIMEOUT_MS).toBe(5000);
      expect(SCAN_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
      expect(took).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS - 200);
      expect(took).toBeLessThan(SCAN_TIMEOUT_MS);
      expect(r.instances.map((i) => i.label)).toEqual(["VS Code 1.143.1"]);
      expect(r.rejected).toEqual([expect.objectContaining({ label: "VSCodium 1.140.0", reason: expect.stringMatching(/no answer within 5 s \(killed\)/) })]);
      const pid = Number(fs.readFileSync(pidfile, "utf8"));
      await new Promise((res) => setTimeout(res, 200));
      expect(isAlive(pid)).toBe(false); // killed, not left sleeping
    } finally {
      delete process.env.HANG_PIDFILE;
    }
  }, 20_000);

  it("runs apps whose folders have spaces and shell characters without a shell", async () => {
    const { apps, base } = fixture();
    const marker = `WB_FS_INJECTED_${process.pid}`;
    makeApp(apps, { name: `Visual Studio Code - Insiders; touch ${marker} $(touch ${marker}).app`, bundleId: "com.microsoft.VSCodeInsiders", version: "1.144.0-insider", cli: "code", script: PASS_SCRIPT });
    // a custom CLI whose path holds `; $( )` and a backtick
    const weird = path.join(base, "my code; $( ) `x`");
    fs.mkdirSync(weird);
    const custom = path.join(weird, "co de");
    fs.writeFileSync(custom, PASS_SCRIPT, { mode: 0o755 });
    const r = await scanInstances({ roots: [apps], customCliPath: custom });
    expect(r.instances.map((i) => i.kind)).toEqual(["vscode-insiders", "custom"]);
    for (const where of [process.cwd(), apps, base, weird]) expect(fs.existsSync(path.join(where, marker))).toBe(false);
  });

  it("a symlinked CLI and a symlinked app are followed", async () => {
    const { apps, base } = fixture();
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    const app = makeApp(real, { name: "VSCodium.app", bundleId: "com.vscodium", version: "1.140.0", cli: "codium", script: PASS_SCRIPT });
    fs.symlinkSync(app, path.join(apps, "VSCodium.app"));
    const r = await scanInstances({ roots: [apps] });
    expect(r.instances.map((i) => i.label)).toEqual(["VSCodium 1.140.0"]);
  });
});

describe("F3: nothing in the instances' folders is written, renamed, deleted or chmod-ed", () => {
  it("scan, probe, choose and copy leave a read-only fixture tree byte-identical (hash before and after)", async () => {
    const { apps, support } = fixture();
    makeApp(apps, { name: "Visual Studio Code.app", bundleId: "com.microsoft.VSCodeInsiders", version: "1.144.0-insider", cli: "code", script: PASS_SCRIPT });
    makeApp(apps, { name: "VSCodium.app", bundleId: "com.vscodium", version: "1.140.0", cli: "codium", script: EXIT1_SCRIPT });
    makeApp(apps, { name: "Antigravity IDE.app", bundleId: "com.google.antigravity-ide", version: "1.3.0", cli: "antigravity-ide", script: MISSING_HELPER_SCRIPT });
    makeApp(apps, { name: "Antigravity.app", bundleId: "com.google.antigravity", version: "1.2.0", cli: null });
    // the user's folders and their extensions
    const user = path.join(support, "Code - Insiders", "User");
    fs.mkdirSync(user, { recursive: true });
    fs.writeFileSync(path.join(user, "settings.json"), '{\n  // mine\n  "editor.fontSize": 15,\n}\n');
    fs.writeFileSync(path.join(user, "keybindings.json"), "[]\n");
    fs.symlinkSync(path.join(user, "keybindings.json"), path.join(user, "kb-link.json"));
    fs.mkdirSync(path.join(support, "VSCodium", "User"), { recursive: true });
    const dotDir = path.join(path.dirname(apps), "dot-vscode-insiders", "extensions", "ms-python.python-1.0.0");
    fs.mkdirSync(dotDir, { recursive: true });
    fs.writeFileSync(path.join(dotDir, "package.json"), "{}");

    const base = path.dirname(apps);
    makeReadOnly(base);
    const before = treeDigest(base);

    const userData = path.join(tempDir(), "plugin-user-data");
    const scan = await scanInstances({ roots: [apps] });
    const sel = chooseInstance(scan, null);
    expect(sel.selected?.label).toBe("VS Code Insiders 1.144.0-insider");
    const result = seedUserData({ userDataDir: userData, sourceUserDir: instanceUserDir(sel.selected!.userDataName, support) });
    expect(result).toMatchObject({ settings: "copied", keybindings: true });

    expect(treeDigest(base)).toBe(before);
    // the destination is inside the plugin's user-data dir, and nothing else got created
    expect(path.relative(userData, result.settingsFile).startsWith("..")).toBe(false);
    expect(fs.readdirSync(userData)).toEqual(["User"]);
    expect(fs.readFileSync(result.keybindingsFile, "utf8")).toBe("[]\n");
  });

  it("the digest does change when something is written (the check can fail)", () => {
    const { base } = fixture();
    fs.writeFileSync(path.join(base, "a.txt"), "x");
    const d0 = treeDigest(base);
    fs.writeFileSync(path.join(base, "a.txt"), "y");
    expect(treeDigest(base)).not.toBe(d0);
    const d1 = treeDigest(base);
    fs.chmodSync(path.join(base, "a.txt"), 0o600);
    expect(treeDigest(base)).not.toBe(d1);
    const d2 = treeDigest(base);
    fs.renameSync(path.join(base, "a.txt"), path.join(base, "b.txt"));
    expect(treeDigest(base)).not.toBe(d2);
  });

  it("a write attempt on a read-only source fails (the fixture really is read-only)", () => {
    const { base, support } = fixture();
    const f = path.join(support, "settings.json");
    fs.writeFileSync(f, "{}");
    makeReadOnly(base);
    expect(() => fs.writeFileSync(f, "x")).toThrow(/EACCES|EPERM/);
    expect(() => fs.renameSync(f, f + ".bak")).toThrow(/EACCES|EPERM/);
    expect(() => fs.rmSync(f)).toThrow(/EACCES|EPERM/);
  });

  it("the copy refuses a destination inside the instance's folder, so a mistaken path can never write there", () => {
    const { support } = fixture();
    const user = path.join(support, "Code", "User");
    fs.mkdirSync(user, { recursive: true });
    fs.writeFileSync(path.join(user, "settings.json"), "{}");
    const before = treeDigest(support);
    expect(() => seedUserData({ userDataDir: path.join(support, "Code"), sourceUserDir: user })).toThrow();
    expect(() => seedUserData({ userDataDir: user, sourceUserDir: user })).toThrow();
    expect(treeDigest(support)).toBe(before);
  });
});

describe("the probe starts no server and makes no network call", () => {
  it("only ever runs `serve-web --help`: a stub that logs its arguments sees nothing else", async () => {
    const { apps, base } = fixture();
    const log = path.join(base, "calls.log");
    const script = `#!/bin/sh\necho "$*" >> "${log}"\n${PASS_SCRIPT.split("\n").slice(1).join("\n")}`;
    makeApp(apps, { name: "Visual Studio Code.app", bundleId: "com.microsoft.VSCode", version: "1.143.1", cli: "code", script });
    makeApp(apps, { name: "VSCodium.app", bundleId: "com.vscodium", version: "1.140.0", cli: "codium", script });
    await scanInstances({ roots: [apps] });
    const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
    expect(calls).toEqual(["serve-web --help", "serve-web --help"]);
  });

  it("the probe module has no network, server or download code", () => {
    const code = fs.readFileSync(path.resolve(__dirname, "../../src/instances/probe.ts"), "utf8");
    for (const word of ["node:net", "node:http", "node:https", "fetch(", "requestUrl", "WebSocket", "listen("]) expect(code).not.toContain(word);
    expect(code).not.toMatch(/exec\(|execSync|shell:\s*true|spawn\(/); // execFile with an argument array only
    expect(code).toMatch(/execFile\(/);
  });
});

describe("tests/fixtures/make-fake-instances.sh", () => {
  const script = path.resolve(__dirname, "../fixtures/make-fake-instances.sh");

  it("builds fake bundles whose stub answers serve-web --help; the scan lists the three that pass and none of the failing ones; clean removes the tree", async () => {
    const base = tempDir();
    const root = path.join(base, "fake");
    const out = execFileSync(script, [root], { encoding: "utf8" });
    const env = Object.fromEntries([...out.matchAll(/^export (\w+)='(.*)'$/gm)].map((m) => [m[1], m[2]]));
    expect(Object.keys(env).sort()).toEqual(["WORKBENCH_APP_SUPPORT_ROOT", "WORKBENCH_SCAN_ROOTS"]);
    const r = await scanInstances({ env });
    expect(r.instances.map((i) => i.label)).toEqual(["VS Code 1.143.1", "VS Code Insiders 1.144.0-insider", "VSCodium 1.140.0"]);
    expect(r.rejected.map((x) => x.label).sort()).toEqual(["Antigravity 1.0.0", "Antigravity IDE 1.0.0", "VS Code 1.100.0"]);
    expect(chooseInstance(r, null).selected?.label).toBe("VS Code Insiders 1.144.0-insider");
    // the seed source it makes is the Insiders user folder, JSONC and all
    const seeded = seedUserData({ userDataDir: path.join(base, "ud"), sourceUserDir: instanceUserDir("Code - Insiders", env.WORKBENCH_APP_SUPPORT_ROOT) });
    expect(seeded).toMatchObject({ settings: "copied", keybindings: true });

    expect(() => execFileSync(script, ["clean", base], { encoding: "utf8", stdio: "pipe" })).toThrow(/not made by make-fake-instances/);
    expect(fs.existsSync(base)).toBe(true);
    execFileSync(script, ["clean", root]);
    expect(fs.existsSync(root)).toBe(false);
  });
});
