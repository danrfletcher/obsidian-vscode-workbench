/**
 * The plugin-owned terminal-at extension's plumbing (G8, E10, F6): what an install writes and where, that it keeps the shared
 * extensions' entries, and that every request is a file of its own, whole, in the order it was made.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EXTENSION_DIR_NAME,
  EXTENSION_ID,
  PAGE_SEEN_FILE,
  REQUESTS_DIR,
  extensionDir,
  extensionManifest,
  installTerminalAtExtension,
  writeTerminalRequest,
} from "../../src/terminal-host/terminal-at-extension";
import { tempDir } from "../helpers";

let data: string;
const list = () => JSON.parse(fs.readFileSync(path.join(data, "extensions", "extensions.json"), "utf8")) as Array<{ identifier: { id: string }; relativeLocation: string }>;
const requests = () => path.join(extensionDir(data), REQUESTS_DIR);

beforeEach(() => {
  data = tempDir();
});

describe("installTerminalAtExtension", () => {
  it("writes the manifest, the code and an empty requests folder under the server's own extensions dir, and lists it", () => {
    installTerminalAtExtension(data);
    expect(fs.readdirSync(path.join(data, "extensions")).sort()).toEqual(["extensions.json", EXTENSION_DIR_NAME]);
    expect(fs.readdirSync(extensionDir(data)).sort()).toEqual(["extension.js", "package.json", REQUESTS_DIR]);
    expect(fs.readdirSync(requests())).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(extensionDir(data), "package.json"), "utf8"))).toEqual(extensionManifest());
    expect(list().map((e) => e.identifier.id)).toEqual([EXTENSION_ID]);
  });

  it("the extension contributes nothing visible (F1): no views, menus, keybindings, commands or UI", () => {
    const manifest = extensionManifest() as { contributes?: Record<string, unknown> };
    const contributed = Object.keys(manifest.contributes ?? {}).filter((k) => !["configuration"].includes(k));
    expect(contributed).toEqual([]);
  });

  it("declares that it supports untrusted workspaces, so it still runs in Restricted Mode (the panel-only layout and the terminal at a folder depend on it)", () => {
    expect(extensionManifest().capabilities).toEqual({ untrustedWorkspaces: { supported: true } });
    // and the declaration is in the package.json the install actually wrote, which is what VS Code reads
    installTerminalAtExtension(data);
    const written = JSON.parse(fs.readFileSync(path.join(extensionDir(data), "package.json"), "utf8")) as { main?: string; capabilities?: unknown };
    expect(written.main).toBe("./extension.js");
    expect(written.capabilities).toEqual({ untrustedWorkspaces: { supported: true } });
  });

  it("keeps the entries already in extensions.json and does not list itself twice on a second start", () => {
    fs.mkdirSync(path.join(data, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(data, "extensions", "extensions.json"), JSON.stringify([{ identifier: { id: "ms-python.python" }, relativeLocation: "ms-python.python-1.0.0" }]));
    installTerminalAtExtension(data);
    installTerminalAtExtension(data);
    expect(list().map((e) => e.identifier.id)).toEqual(["ms-python.python", EXTENSION_ID]);
  });

  it("starts from an empty list when extensions.json is not JSON", () => {
    fs.mkdirSync(path.join(data, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(data, "extensions", "extensions.json"), "{not json");
    installTerminalAtExtension(data);
    expect(list().map((e) => e.identifier.id)).toEqual([EXTENSION_ID]);
  });

  it("removes an older version of itself and requests left by an earlier run, and leaves other extensions' folders alone", () => {
    const old = path.join(data, "extensions", `${EXTENSION_ID}-0.9.0`);
    const other = path.join(data, "extensions", "ms-python.python-1.0.0");
    fs.mkdirSync(old, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    installTerminalAtExtension(data);
    writeTerminalRequest(data, { cwd: "/x" });
    expect(fs.readdirSync(requests())).toHaveLength(1);
    installTerminalAtExtension(data);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(other)).toBe(true);
    expect(fs.readdirSync(requests())).toEqual([]);
  });
});

describe("the page-seen mark", () => {
  it("is removed at each server start, so the next server run's first page can take the place of its own first terminal", () => {
    installTerminalAtExtension(data);
    fs.writeFileSync(path.join(extensionDir(data), PAGE_SEEN_FILE), "");
    installTerminalAtExtension(data);
    expect(fs.existsSync(path.join(extensionDir(data), PAGE_SEEN_FILE))).toBe(false);
    expect(fs.readdirSync(extensionDir(data)).sort()).toEqual(["extension.js", "package.json", REQUESTS_DIR]);
  });
});

describe("writeTerminalRequest", () => {
  it("writes the cwd as data, byte for byte, in a file of JSON that names nothing else", () => {
    installTerminalAtExtension(data);
    const awkward = "/Users/dan/Vault/it's $HOME & (x) \"q\" `b` ;日本語 Café";
    const id = writeTerminalRequest(data, { cwd: awkward });
    const [file] = fs.readdirSync(requests());
    const body = JSON.parse(fs.readFileSync(path.join(requests(), file), "utf8"));
    expect(body).toEqual({ id, cwd: awkward });
    expect(Buffer.from(body.cwd)).toEqual(Buffer.from(awkward));
  });

  it("adoptFirst is written only when it is true", () => {
    installTerminalAtExtension(data);
    const a = writeTerminalRequest(data, { cwd: "/a", adoptFirst: true });
    const b = writeTerminalRequest(data, { cwd: "/b", adoptFirst: false });
    const c = writeTerminalRequest(data, { cwd: "/c" });
    const bodies = fs.readdirSync(requests()).sort().map((f) => JSON.parse(fs.readFileSync(path.join(requests(), f), "utf8")));
    expect(bodies).toEqual([{ id: a, cwd: "/a", adoptFirst: true }, { id: b, cwd: "/b" }, { id: c, cwd: "/c" }]);
  });

  it("with no folder the request carries no cwd at all", () => {
    installTerminalAtExtension(data);
    const id = writeTerminalRequest(data, { cwd: null });
    const [file] = fs.readdirSync(requests());
    expect(JSON.parse(fs.readFileSync(path.join(requests(), file), "utf8"))).toEqual({ id });
  });

  it("calls in the same millisecond each get their own file, and the names sort in the order the calls were made", () => {
    installTerminalAtExtension(data);
    const ids = ["a", "b", "c", "d", "e"].map((c) => writeTerminalRequest(data, { cwd: `/${c}` }, () => 1_700_000_000_000));
    const files = fs.readdirSync(requests()).sort();
    expect(files).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(files.map((f) => JSON.parse(fs.readFileSync(path.join(requests(), f), "utf8")).cwd)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
  });

  it("leaves no temporary file behind, and writes only under the extension's requests folder", () => {
    installTerminalAtExtension(data);
    writeTerminalRequest(data, { cwd: "/x" });
    expect(fs.readdirSync(requests()).every((f) => f.endsWith(".json") && !f.startsWith("."))).toBe(true);
    expect(fs.readdirSync(data)).toEqual(["extensions"]);
  });
});
