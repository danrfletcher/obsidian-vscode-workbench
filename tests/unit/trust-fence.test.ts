/**
 * The fence around the trust seed (ticket warkworth-36, PR-2): Workspace Trust is never turned off, only the vault
 * folder is trusted, the seed adds nothing to the workbench page, and it touches no file.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceLeaf } from "../mocks/obsidian";
import { CodeView, type CodeViewHost } from "../../src/code-view";
import { BROWSER_APP_SETTINGS, workbenchOverlay, writeMachineSettings } from "../../src/settings";
import { buildTrustSeedScript } from "../../src/trust/trust-seed";
import { FakeWebview, tempDir } from "../helpers";

const SRC = path.resolve(__dirname, "../../src");
const sourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : /\.(ts|mjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : []));

describe("F3: Workspace Trust is never switched off", () => {
  it("no file under src/ assigns security.workspace.trust.enabled (or any security.workspace.trust.* key) as a value", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(SRC)) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        // an assignment: the key as an object key or a property assigned a value, not a comment that names it
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/\/\*.*?\*\//g, "");
        if (/["'`]security\.workspace\.trust\.[\w.]*["'`]\s*[:=\]]/.test(code) || /\[\s*["'`]security\.workspace\.trust/.test(code) || /security\.workspace\.trust\.[\w.]*\s*=[^=]/.test(code)) {
          offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the grep above would catch an assignment (the detector itself works)", () => {
    const hit = (line: string) => /["'`]security\.workspace\.trust\.[\w.]*["'`]\s*[:=\]]/.test(line) || /\[\s*["'`]security\.workspace\.trust/.test(line);
    expect(hit('  "security.workspace.trust.enabled": false,')).toBe(true);
    expect(hit('settings["security.workspace.trust.enabled"] = false;')).toBe(true);
    expect(hit("// security.workspace.trust.enabled was removed")).toBe(false);
  });

  it("the Machine settings file, the browser seed settings and the dark/light overlays contain no trust key", () => {
    const dir = tempDir();
    const file = writeMachineSettings(dir, { dark: true });
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/trust/i);
    expect(JSON.stringify(BROWSER_APP_SETTINGS)).not.toMatch(/trust/i);
    for (const dark of [true, false]) expect(JSON.stringify(workbenchOverlay({ dark }))).not.toMatch(/trust/i);
  });

  it("the trust script writes only the one record key, and never a settings key", () => {
    const script = buildTrustSeedScript({ origin: "http://127.0.0.1:5555", folderUri: "vscode-remote://127.0.0.1:5555/Users/dan/Notes", heldPorts: [5555] });
    expect(script.match(/\.put\(/g)).toHaveLength(1);
    expect(script).not.toContain("security.workspace");
    expect(script).not.toContain("settings.json");
    expect(script).not.toContain("userdata");
  });
});

describe("F3, G17: only the vault folder is trusted", () => {
  const vaults = ["/Users/dan/Notes", "/Users/dan/My Vault", "/Users/dan/Zürich 文件", "/a", "/Users/dan/100%/a#b?c"];
  it.each(vaults)("the script for %s carries exactly one entry, and its path is the vault root", (vault) => {
    const origin = "http://127.0.0.1:5555";
    const folderUri = `vscode-remote://127.0.0.1:5555${vault.split("/").map(encodeURIComponent).join("/")}`;
    const script = buildTrustSeedScript({ origin, folderUri, heldPorts: [5555] });
    const entry = JSON.parse(/const entry = (\{.*\});/.exec(script)![1]) as { uri: { path: string }; trusted: boolean };
    expect(entry.uri.path).toBe(vault);
    expect(entry.trusted).toBe(true);
    expect(script.match(/const entry = /g)).toHaveLength(1);
    expect(script.match(/"trusted":/g)).toHaveLength(1);
    // every path the script mentions is the vault root: no parent, home or sibling is spelled out
    const mentioned = [...script.matchAll(/"path":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]) as string);
    expect(mentioned).toEqual([vault]);
  });
});

describe("F5: the seed adds nothing to the workbench page", () => {
  it("the script reads and writes IndexedDB and touches no document, window, element or style", () => {
    const script = buildTrustSeedScript({ origin: "http://127.0.0.1:5555", folderUri: "vscode-remote://127.0.0.1:5555/Users/dan/Notes", heldPorts: [5555] });
    for (const word of ["document", "window", "createElement", "appendChild", "innerHTML", "insertAdjacent", "classList", "style", "localStorage", "sessionStorage", "fetch(", "XMLHttpRequest", "postMessage"]) {
      expect(script, word).not.toContain(word);
    }
  });
});

const FS_WRITERS = ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "copyFile", "copyFileSync", "cp", "cpSync", "rename", "renameSync", "rm", "rmSync", "unlink", "unlinkSync", "mkdir", "mkdirSync", "createWriteStream", "truncate", "truncateSync", "symlink", "symlinkSync"] as const;
/** Spy on every fs function that writes, passing the call through; the returned list holds what was called. */
function spyFsWrites(): string[] {
  const calls: string[] = [];
  for (const n of FS_WRITERS) {
    const orig = (fs as unknown as Record<string, (...a: unknown[]) => unknown>)[n];
    (vi.spyOn(fs as never, n as never) as unknown as { mockImplementation(f: (...a: unknown[]) => unknown): void }).mockImplementation((...a: unknown[]) => {
      calls.push(`${n}(${String(a[0])})`);
      return orig(...a);
    });
  }
  return calls;
}

describe("F1: the seed opens no file for writing", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { createElement: (t: string) => new FakeWebview(t) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("the spy sees a write (so an empty list below means something)", () => {
    const calls = spyFsWrites();
    fs.mkdirSync(path.join(tempDir(), "probe"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("mkdirSync");
  });

  it("loading a Code tab with the seed on calls no fs write, append, open-for-write, copy, rename, remove or mkdir function", async () => {
    const calls = spyFsWrites();
    const noted: string[] = [];
    const host: CodeViewHost = {
      vaultRoot: () => "/Users/dan/Notes",
      embedElement: () => "webview",
      ensureServer: async () => ({ baseUrl: "http://127.0.0.1:5555", port: 5555, token: "tok" }),
      trackView: () => undefined,
      untrackView: () => undefined,
      serverState: () => "running",
      onServerState: () => () => undefined,
      restartServer: async () => undefined,
      userDataCopy: () => null,
      admitFile: async () => true,
      releaseFile: () => undefined,
      openInSystemApp: () => undefined,
      trustVaultFolder: () => true,
      heldPorts: () => [5555],
      noteTrustOutcome: (o) => void noted.push(o),
    };
    const view = new CodeView(new WorkspaceLeaf() as never, host);
    (view as unknown as { contentEl: FakeWebview }).contentEl = new FakeWebview("div");
    await view.setState({ file: "a.py" }, {} as never);
    expect(noted).toEqual(["seeded"]);
    expect(calls).toEqual([]);
  });
});
