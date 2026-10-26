import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { appSupportRoot, bundleIdFromPlist, classifyBundle, describeCustom, scanInstances, scanRoots, type Instance } from "../../src/instances/scan";
import type { ProbeResult } from "../../src/instances/probe";
import { makeAllKnown, makeApp, PASS_SCRIPT } from "../instance-helpers";
import { tempDir } from "../helpers";

/** A probe that answers from a table keyed by the CLI's app folder name; records what it was asked. */
function tableProbe(answers: Record<string, ProbeResult>, asked: string[] = []) {
  return async (cli: string): Promise<ProbeResult> => {
    asked.push(cli);
    const app = cli.split(path.sep).find((s) => s.endsWith(".app")) ?? cli;
    return answers[app] ?? { ok: true };
  };
}

const labels = (r: { instances: Instance[] }) => r.instances.map((i) => i.label);

describe("scanInstances: known builds", () => {
  it("lists every known build whose probe passes, with kind, version and CLI", async () => {
    const root = tempDir();
    makeAllKnown(root);
    const r = await scanInstances({ roots: [root], probe: tableProbe({}) });
    expect(r.instances.map((i) => [i.kind, i.version, path.basename(i.cli)])).toEqual([
      ["vscode", "1.143.1", "code"],
      ["vscode-insiders", "1.144.0-insider", "code"],
      ["vscodium", "1.140.0", "codium"],
      ["antigravity", "1.2.0", "antigravity"],
      ["antigravity-ide", "1.3.0", "antigravity-ide"],
    ]);
    expect(labels(r)).toEqual(["VS Code 1.143.1", "VS Code Insiders 1.144.0-insider", "VSCodium 1.140.0", "Antigravity 1.2.0", "Antigravity IDE 1.3.0"]);
    expect(r.rejected).toEqual([]);
    expect(r.customFailure).toBeNull();
  });

  it("flags only the Microsoft builds as Microsoft (the E8 warning follows this)", async () => {
    const root = tempDir();
    makeAllKnown(root);
    const r = await scanInstances({ roots: [root], probe: tableProbe({}) });
    expect(Object.fromEntries(r.instances.map((i) => [i.kind, i.microsoft]))).toEqual({
      vscode: true,
      "vscode-insiders": true,
      vscodium: false,
      antigravity: false,
      "antigravity-ide": false,
    });
  });

  it("classifies by bundle identifier, not by folder name: 'Visual Studio Code.app' that is really Insiders", async () => {
    const root = tempDir();
    makeApp(root, { name: "Visual Studio Code.app", bundleId: "com.microsoft.VSCodeInsiders", version: "1.144.0-insider", cli: "code" });
    const r = await scanInstances({ roots: [root], probe: tableProbe({}) });
    expect(r.instances).toHaveLength(1);
    expect(r.instances[0]).toMatchObject({ kind: "vscode-insiders", version: "1.144.0-insider", label: "VS Code Insiders 1.144.0-insider" });
  });

  it("falls back to product.json when Info.plist is missing, and to the plist when product.json is missing", async () => {
    const root = tempDir();
    makeApp(root, { name: "A.app", bundleId: "com.vscodium", version: "1.1.0", cli: "codium", plist: false });
    makeApp(root, { name: "B.app", bundleId: "com.microsoft.VSCode", version: "1.2.0", cli: "code", product: false });
    const r = await scanInstances({ roots: [root], probe: tableProbe({}) });
    expect(r.instances.map((i) => [i.kind, i.version])).toEqual([
      ["vscode", ""],
      ["vscodium", "1.1.0"],
    ]);
    expect(r.instances.find((i) => i.kind === "vscode")?.label).toBe("VS Code");
  });

  it("ignores apps that are not known builds, and entries that are not apps", async () => {
    const root = tempDir();
    makeApp(root, { name: "Safari.app", bundleId: "com.apple.Safari", version: "26.0", cli: "code" });
    fs.writeFileSync(path.join(root, "notes.txt"), "x");
    fs.mkdirSync(path.join(root, "Folder"));
    const r = await scanInstances({ roots: [root], probe: tableProbe({}) });
    expect(r).toEqual({ instances: [], rejected: [], customFailure: null });
  });

  it("works with paths that contain spaces", async () => {
    const root = path.join(tempDir(), "My Apps");
    fs.mkdirSync(root);
    makeApp(root, { name: "Visual Studio Code - Insiders.app", bundleId: "com.microsoft.VSCodeInsiders", version: "1.144.0-insider", cli: "code" });
    const r = await scanInstances({ roots: [root], probe: tableProbe({}) });
    expect(r.instances[0].cli).toBe(path.join(root, "Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code"));
  });
});

describe("scanInstances: not offered (E1)", () => {
  it.each([
    ["no bin folder (Antigravity.app here)", { cli: null as string | null }, /no Contents\/Resources\/app\/bin folder/],
    ["a bin folder without the CLI file", { cli: "antigravity", script: null as string | null }, /none of antigravity is in its bin folder/],
    ["a CLI that is not executable", { cli: "antigravity", mode: 0o644 }, /not executable/],
  ])("%s", async (_name, extra, reason) => {
    const root = tempDir();
    makeApp(root, { name: "Antigravity.app", bundleId: "com.google.antigravity", version: "1.0.0", ...extra });
    const asked: string[] = [];
    const r = await scanInstances({ roots: [root], probe: tableProbe({}, asked) });
    expect(r.instances).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].reason).toMatch(reason);
    expect(asked).toEqual([]); // nothing to run, so nothing was run
  });

  it("a build whose probe fails is rejected with the reason and the others stay listed", async () => {
    const root = tempDir();
    makeAllKnown(root);
    const r = await scanInstances({
      roots: [root],
      probe: tableProbe({ "Antigravity IDE.app": { ok: false, reason: "the program (or a helper it needs) was not found (ENOENT)." } }),
    });
    expect(labels(r)).not.toContain("Antigravity IDE 1.3.0");
    expect(labels(r)).toHaveLength(4);
    expect(r.rejected).toEqual([expect.objectContaining({ label: "Antigravity IDE 1.3.0", reason: expect.stringContaining("ENOENT") })]);
  });

  it("answers within the scan limit even when a probe never answers, keeping the builds that did", async () => {
    const root = tempDir();
    makeAllKnown(root);
    const probe = (cli: string): Promise<ProbeResult> => (cli.includes("VSCodium") ? new Promise(() => undefined) : Promise.resolve({ ok: true }));
    const started = Date.now();
    const r = await scanInstances({ roots: [root], probe, scanTimeoutMs: 80 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(labels(r)).toEqual(["VS Code 1.143.1", "VS Code Insiders 1.144.0-insider", "Antigravity 1.2.0", "Antigravity IDE 1.3.0"]);
  });

  it("probes in parallel: the scan takes about one probe, not the sum", async () => {
    const root = tempDir();
    makeAllKnown(root);
    let running = 0;
    let peak = 0;
    const probe = async (): Promise<ProbeResult> => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return { ok: true };
    };
    await scanInstances({ roots: [root], probe });
    expect(peak).toBe(5);
  });
});

describe("scanInstances: roots", () => {
  it("scans both roots, skips a missing one, and lists one install once when two roots reach it", async () => {
    const a = tempDir();
    const b = tempDir();
    const app = makeApp(a, { name: "VSCodium.app", bundleId: "com.vscodium", version: "1.140.0", cli: "codium" });
    fs.symlinkSync(app, path.join(b, "VSCodium.app"));
    makeApp(b, { name: "Visual Studio Code.app", bundleId: "com.microsoft.VSCode", version: "1.143.1", cli: "code" });
    const r = await scanInstances({ roots: [a, b, path.join(a, "does-not-exist")], probe: tableProbe({}) });
    expect(labels(r)).toEqual(["VS Code 1.143.1", "VSCodium 1.140.0"]);
  });

  it("gives the same app in two roots two entries with different ids", async () => {
    const a = tempDir();
    const b = tempDir();
    makeApp(a, { name: "Visual Studio Code.app", bundleId: "com.microsoft.VSCode", version: "1.143.1", cli: "code" });
    makeApp(b, { name: "Visual Studio Code.app", bundleId: "com.microsoft.VSCode", version: "1.142.0", cli: "code" });
    const r = await scanInstances({ roots: [a, b], probe: tableProbe({}) });
    expect(new Set(r.instances.map((i) => i.id)).size).toBe(2);
  });

  it("reads /Applications and ~/Applications by default; WORKBENCH_SCAN_ROOTS (test only) replaces them", () => {
    expect(scanRoots({}, "/home/dan")).toEqual(["/Applications", "/home/dan/Applications"]);
    expect(scanRoots({ WORKBENCH_SCAN_ROOTS: "/a:/b b" }, "/home/dan")).toEqual(["/a", "/b b"]);
    expect(scanRoots({ WORKBENCH_SCAN_ROOTS: "" }, "/home/dan")).toEqual([]);
    expect(appSupportRoot({}, "/home/dan")).toBe("/home/dan/Library/Application Support");
    expect(appSupportRoot({ WORKBENCH_APP_SUPPORT_ROOT: "/x" }, "/home/dan")).toBe("/x");
  });

  it("takes the roots from WORKBENCH_SCAN_ROOTS in the given environment", async () => {
    const root = tempDir();
    makeApp(root, { name: "VSCodium.app", bundleId: "com.vscodium", version: "1.140.0", cli: "codium" });
    const r = await scanInstances({ env: { WORKBENCH_SCAN_ROOTS: root }, probe: tableProbe({}) });
    expect(labels(r)).toEqual(["VSCodium 1.140.0"]);
  });
});

describe("scanInstances: the saved custom CLI", () => {
  it("lists a passing custom CLI last, as Custom, with its own id", async () => {
    const root = tempDir();
    makeApp(root, { name: "VSCodium.app", bundleId: "com.vscodium", version: "1.140.0", cli: "codium" });
    const custom = path.join(tempDir(), "my code");
    fs.writeFileSync(custom, PASS_SCRIPT, { mode: 0o755 });
    const r = await scanInstances({ roots: [root], customCliPath: custom, probe: tableProbe({}) });
    expect(r.instances.map((i) => i.id)).toEqual([expect.stringMatching(/^vscodium:/), "custom"]);
    expect(r.instances[1]).toMatchObject({ label: "Custom", cli: custom, kind: "custom", appPath: null });
  });

  it.each([
    ["missing", (d: string) => path.join(d, "gone"), /no longer exists/],
    ["a folder", (d: string) => d, /folder/],
    [
      "not executable",
      (d: string) => {
        const f = path.join(d, "plain");
        fs.writeFileSync(f, "x", { mode: 0o644 });
        return f;
      },
      /not executable/,
    ],
  ])("reports a custom CLI that is %s", async (_n, make, reason) => {
    const d = tempDir();
    const r = await scanInstances({ roots: [], customCliPath: make(d), probe: tableProbe({}) });
    expect(r.instances).toEqual([]);
    expect(r.customFailure).toMatch(reason);
  });

  it("reports a custom CLI whose probe fails", async () => {
    const f = path.join(tempDir(), "code");
    fs.writeFileSync(f, PASS_SCRIPT, { mode: 0o755 });
    const r = await scanInstances({ roots: [], customCliPath: f, probe: async () => ({ ok: false, reason: "nope" }) });
    expect(r.customFailure).toBe("nope");
  });

  it("takes version, kind and user folder from the app a custom CLI sits in", () => {
    const root = tempDir();
    const app = makeApp(root, { name: "Elsewhere.app", bundleId: "com.vscodium", version: "1.99.0", cli: "codium" });
    const i = describeCustom(path.join(app, "Contents/Resources/app/bin/codium"));
    expect(i).toMatchObject({ id: "custom", kind: "vscodium", version: "1.99.0", userDataName: "VSCodium", microsoft: false });
  });
});

describe("bundle helpers", () => {
  it("reads CFBundleIdentifier from an XML plist and returns null otherwise", () => {
    const d = tempDir();
    fs.writeFileSync(path.join(d, "a.plist"), "<plist><dict><key>CFBundleName</key><string>x</string><key>CFBundleIdentifier</key>\n\t<string>com.vscodium</string></dict></plist>");
    fs.writeFileSync(path.join(d, "b.plist"), "bplist00\u0000\u0001");
    expect(bundleIdFromPlist(path.join(d, "a.plist"))).toBe("com.vscodium");
    expect(bundleIdFromPlist(path.join(d, "b.plist"))).toBeNull();
    expect(bundleIdFromPlist(path.join(d, "missing.plist"))).toBeNull();
  });

  it("classifyBundle returns null for an unknown bundle id", () => {
    const root = tempDir();
    const app = makeApp(root, { name: "X.app", bundleId: "com.example.x", version: "1", cli: "code" });
    expect(classifyBundle(app)).toBeNull();
  });
});
