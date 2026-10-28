/**
 * PR-5: the server shares exactly the extensions that are enabled in the mirrored profile (G2, G10, E5, F1, F2, F7, F9).
 * The pieces are the real ones: the profile's `extensions.json` is read from disk by `readProfileExtensions`, the
 * enabled set is worked out by `enabledExtensions`, and `shareExtensions` links and writes under a temp server data
 * dir. Only the disabled lists are plain objects (what src/mirror/ would have answered; no `sqlite3` here).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MirrorResult } from "../../src/mirror/mirror";
import { findMirroredProfile } from "../../src/profile/mirrored-profile";
import { danglingSharedLinks, shareExtensions } from "../../src/server";
import {
  enabledExtensions,
  parseProfileExtensions,
  profileExtensionsFile,
  readProfileExtensions,
  type MirrorState,
} from "../../src/server/shared-extensions";
import { REPO_ROOT, tempDir } from "../helpers";
import { makeReadOnly, makeWritable, treeDigest } from "../instance-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const writable: string[] = [];
afterEach(() => {
  for (const d of writable.splice(0)) makeWritable(d);
});

/** The instance's extensions folder with one folder (holding a package.json) per name. */
function instanceFolder(names: string[]): string {
  const dir = path.join(tempDir(), ".vscode-insiders", "extensions");
  for (const n of names) {
    fs.mkdirSync(path.join(dir, n), { recursive: true });
    fs.writeFileSync(path.join(dir, n, "package.json"), JSON.stringify({ name: n }));
  }
  fs.writeFileSync(path.join(dir, ".obsolete"), "{}");
  return dir;
}

/** An entry in the shape VS Code writes: an absolute `location` into the instance's folder. */
function entry(src: string, id: string, folder: string): Record<string, unknown> {
  return {
    identifier: { id, uuid: "0479fc1c-3d67-49f9-b087-fb9069afe48f" },
    version: folder.slice(folder.lastIndexOf("-") + 1),
    location: { $mid: 1, path: path.join(src, folder), scheme: "file" },
    relativeLocation: folder,
    metadata: { installedTimestamp: 1772655254049, pinned: false, source: "gallery" },
  };
}

/** A profile's `extensions.json` in its own folder, as `User/profiles/<loc>/extensions.json`. */
function profileList(entries: unknown): string {
  const dir = path.join(tempDir(), "User", "profiles", "p1");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "extensions.json");
  fs.writeFileSync(file, typeof entries === "string" ? entries : JSON.stringify(entries));
  return file;
}

const read = (disabled: string[]): MirrorResult => ({ source: "read", disabled, counts: { global: disabled.length, profile: null, workspace: 0 }, notes: [], at: 1 });
const snapshot = (disabled: string[]): MirrorResult => ({ source: "snapshot", disabled, takenAt: 1, why: "the disabled list could not be read (test)" });
const none: MirrorResult = { source: "none", disabled: [], why: "the disabled list could not be read (test)" };

const stateOf = (disabled: MirrorResult, file: string | null): MirrorState => ({ disabled, extensions: readProfileExtensions(file) });

/** The links under the plugin's extensions folder, and what its extensions.json lists. */
function shared(data: string): { links: string[]; listed: string[]; raw: string } {
  const target = path.join(data, "extensions");
  const links = fs
    .readdirSync(target)
    .filter((n) => fs.lstatSync(path.join(target, n)).isSymbolicLink())
    .sort();
  const raw = fs.readFileSync(path.join(target, "extensions.json"), "utf8");
  const listed = (JSON.parse(raw) as Array<{ relativeLocation: string }>).map((e) => e.relativeLocation).sort();
  return { links, listed, raw };
}

// ---------------------------------------------------------------------------
// The rules, one row each
// ---------------------------------------------------------------------------

interface Row {
  name: string;
  /** Folders on disk in the instance's extensions folder. */
  folders: string[];
  /** The profile's list: [id, folder]. */
  listed: Array<[string, string]>;
  disabled: MirrorResult;
  /** Expected links, and the same names expected in extensions.json. */
  expected: string[];
}

const TCL = "chakrounanas.turbo-console-log-3.0.0";
const PY = "ms-python.python-2026.10.0";
const PYLANCE = "ms-python.vscode-pylance-2026.4.1";

const ROWS: Row[] = [
  { name: "everything the profile lists and nothing disables is shared", folders: [TCL, PY, PYLANCE], listed: [["chakrounanas.turbo-console-log", TCL], ["ms-python.python", PY], ["ms-python.vscode-pylance", PYLANCE]], disabled: read([]), expected: [PY, PYLANCE, TCL].sort() },
  { name: "G1/G2: a disabled extension has no link and no extensions.json entry", folders: [TCL, PY], listed: [["chakrounanas.turbo-console-log", TCL], ["ms-python.python", PY]], disabled: read(["ms-python.python"]), expected: [TCL] },
  { name: "a disabled list taken from the last good snapshot applies the same way", folders: [TCL, PY], listed: [["chakrounanas.turbo-console-log", TCL], ["ms-python.python", PY]], disabled: snapshot(["chakrounanas.turbo-console-log"]), expected: [PY] },
  { name: "nothing readable (source none): no links, extensions.json is []", folders: [TCL, PY], listed: [["chakrounanas.turbo-console-log", TCL], ["ms-python.python", PY]], disabled: none, expected: [] },
  { name: "every extension disabled: no links, extensions.json is []", folders: [TCL, PY], listed: [["chakrounanas.turbo-console-log", TCL], ["ms-python.python", PY]], disabled: read(["chakrounanas.turbo-console-log", "ms-python.python"]), expected: [] },
  { name: "a folder in the instance's directory that the profile does not list is not shared", folders: [TCL, PY, "other.unlisted-1.0.0"], listed: [["chakrounanas.turbo-console-log", TCL]], disabled: read([]), expected: [TCL] },
  { name: "a profile entry whose folder is missing is skipped and not written", folders: [TCL], listed: [["chakrounanas.turbo-console-log", TCL], ["ms-python.python", PY]], disabled: read([]), expected: [TCL] },
  { name: "ids match case-insensitively (disabled list in lower case, entry in mixed case)", folders: [TCL, PY], listed: [["ChakrounAnas.Turbo-Console-Log", TCL], ["ms-python.python", PY]], disabled: read(["chakrounanas.turbo-console-log"]), expected: [PY] },
  { name: "ids match case-insensitively (disabled list in upper case)", folders: [TCL, PY], listed: [["chakrounanas.turbo-console-log", TCL], ["ms-python.python", PY]], disabled: read(["MS-PYTHON.PYTHON"]), expected: [TCL] },
  { name: "two versions of one extension on disk: only the version the profile lists is linked", folders: ["ms-python.python-2025.1.0", PY], listed: [["ms-python.python", PY]], disabled: read([]), expected: [PY] },
  { name: "two versions on disk, the profile lists the older: the older is linked", folders: ["ms-python.python-2025.1.0", PY], listed: [["ms-python.python", "ms-python.python-2025.1.0"]], disabled: read([]), expected: ["ms-python.python-2025.1.0"] },
  { name: "the same folder listed twice is linked and written once", folders: [PY], listed: [["ms-python.python", PY], ["ms-python.python", PY]], disabled: read([]), expected: [PY] },
  { name: "an empty profile list: no links, extensions.json is []", folders: [TCL, PY], listed: [], disabled: read([]), expected: [] },
];

describe("what the server shares (G2, G10, 'Exactly the enabled set')", () => {
  it.each(ROWS)("$name", (row) => {
    const src = instanceFolder(row.folders);
    const file = profileList(row.listed.map(([id, folder]) => entry(src, id, folder)));
    const data = tempDir();
    const result = shareExtensions(src, data, enabledExtensions(stateOf(row.disabled, file)));
    const out = shared(data);
    expect(out.links).toEqual(row.expected);
    expect(out.listed).toEqual(row.expected);
    expect(result.linked).toBe(row.expected.length);
    if (row.expected.length === 0) expect(out.raw).toBe("[]");
  });

  it("the written extensions.json keeps the rewrite guarantee: every location is the same-named link under the plugin's folder, none points into the instance's", () => {
    const src = instanceFolder([TCL, PY]);
    const file = profileList([entry(src, "chakrounanas.turbo-console-log", TCL), entry(src, "ms-python.python", PY)]);
    const data = tempDir();
    shareExtensions(src, data, enabledExtensions(stateOf(read([]), file)));
    const target = path.join(data, "extensions");
    const out = shared(data);
    expect(out.raw).not.toContain(src);
    expect(out.raw).not.toContain(".vscode-insiders");
    const entries = JSON.parse(out.raw) as Array<{ location: { path: string }; relativeLocation: string }>;
    for (const e of entries) {
      expect(e.location.path).toBe(path.join(target, e.relativeLocation));
      expect(fs.lstatSync(e.location.path).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(e.location.path)).toBe(path.join(src, e.relativeLocation));
    }
  });

  it("keeps every other field of a listed entry as the profile wrote it", () => {
    const src = instanceFolder([TCL]);
    const original = entry(src, "chakrounanas.turbo-console-log", TCL);
    const data = tempDir();
    shareExtensions(src, data, enabledExtensions(stateOf(read([]), profileList([original]))));
    const [written] = JSON.parse(shared(data).raw) as Array<Record<string, unknown>>;
    const { location: _a, ...rest } = written;
    const { location: _b, ...restOriginal } = original;
    expect(rest).toEqual(restOriginal);
  });

  it("an entry with no relativeLocation is found by the last segment of its location", () => {
    const src = instanceFolder([TCL]);
    const e = entry(src, "chakrounanas.turbo-console-log", TCL);
    delete e.relativeLocation;
    const data = tempDir();
    shareExtensions(src, data, enabledExtensions(stateOf(read([]), profileList([e]))));
    expect(shared(data).links).toEqual([TCL]);
  });
});

describe("the profile's list: entries that cannot be shared are left out, and a bad file shares nothing", () => {
  it.each([
    ["no identifier", { location: { path: "/x/a.b-1", scheme: "file" }, relativeLocation: "a.b-1" }],
    ["an empty id", { identifier: { id: " " }, relativeLocation: "a.b-1" }],
    ["no folder name at all", { identifier: { id: "a.b" } }],
    ["a folder name that climbs out (..)", { identifier: { id: "a.b" }, relativeLocation: "../escape" }],
    ["a folder name with a separator", { identifier: { id: "a.b" }, relativeLocation: "sub/a.b-1" }],
    ["a dotfile name", { identifier: { id: "a.b" }, relativeLocation: ".obsolete" }],
    ["the list file's own name", { identifier: { id: "a.b" }, relativeLocation: "extensions.json" }],
    ["something that is not an object", "a.b-1"],
  ])("%s", (_name, bad) => {
    const parsed = parseProfileExtensions(JSON.stringify([bad]));
    expect(parsed).toEqual({ ok: true, extensions: [] });
  });

  it.each([
    ["missing", null, /has no extension list/],
    ["not JSON", "{ nope /Users/dan/secret", /not valid JSON/],
    ["not an array", '{"a":1}', /not a JSON array/],
  ])("%s: nothing is shared, and the reason never quotes the file", (_name, content, why) => {
    const file = content === null ? path.join(tempDir(), "absent", "extensions.json") : profileList(content);
    const r = readProfileExtensions(file);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.why).toMatch(why);
      expect(r.why).not.toContain("secret");
    }
    const src = instanceFolder([TCL]);
    const data = tempDir();
    shareExtensions(src, data, enabledExtensions(stateOf(read([]), file)));
    expect(shared(data)).toMatchObject({ links: [], listed: [], raw: "[]" });
  });

  it("a profile whose list cannot be located (no file path) shares nothing", () => {
    expect(readProfileExtensions(null).ok).toBe(false);
    expect(enabledExtensions(null)).toEqual([]);
  });

  it("a byte-order mark in front of the list does not stop it being read", () => {
    const src = instanceFolder([TCL]);
    const file = profileList("\uFEFF" + JSON.stringify([entry(src, "chakrounanas.turbo-console-log", TCL)]));
    expect(enabledExtensions(stateOf(read([]), file)).map((e) => e.folder)).toEqual([TCL]);
  });

  it("a folder name that climbs out is never linked, and nothing is created outside the plugin's folder", () => {
    const base = tempDir();
    const src = path.join(base, "ext");
    fs.mkdirSync(path.join(base, "escape"), { recursive: true });
    fs.mkdirSync(src);
    const file = profileList([{ identifier: { id: "a.b" }, relativeLocation: "../escape" }]);
    const data = path.join(base, "plugin-data");
    shareExtensions(src, data, enabledExtensions(stateOf(read([]), file)));
    expect(fs.readdirSync(path.join(data, "extensions"))).toEqual(["extensions.json"]);
    expect(fs.readdirSync(path.join(base, "escape"))).toEqual([]);
  });
});

describe("where the profile's list is (PR-3's answer)", () => {
  const files = (extensions: { from: "default" | "profile"; dir: string | null }) => ({ files: { extensions, settings: { from: "default" as const, dir: "/u/User" }, keybindings: { from: "default" as const, dir: "/u/User" } } });

  it("Default, and a profile that reads Default's extensions: the instance's extensions folder", () => {
    expect(profileExtensionsFile(files({ from: "default", dir: null }), "/h/.vscode-insiders/extensions")).toBe("/h/.vscode-insiders/extensions/extensions.json");
  });
  it("a profile with its own list: its folder", () => {
    expect(profileExtensionsFile(files({ from: "profile", dir: "/u/User/profiles/ab12" }), "/h/.vscode-insiders/extensions")).toBe("/u/User/profiles/ab12/extensions.json");
  });
  it("Default with no known extensions folder: no file", () => {
    expect(profileExtensionsFile(files({ from: "default", dir: null }), null)).toBeNull();
  });
  it("agrees with the real lookup: a flagged profile reads Default's, an ordinary profile its own", () => {
    const root = path.join(tempDir(), "Code - Insiders");
    const vault = path.join(tempDir(), "Vault");
    const storage = {
      userDataProfiles: [
        { name: "Own", location: "own1" },
        { name: "Agents", location: "agents1", useDefaultFlags: { extensions: true } },
      ],
      profileAssociations: { workspaces: { [`file://${vault}`]: "own1" } },
    };
    fs.mkdirSync(path.join(root, "User", "globalStorage"), { recursive: true });
    fs.mkdirSync(path.join(root, "User", "profiles", "own1"), { recursive: true });
    fs.mkdirSync(path.join(root, "User", "profiles", "agents1"), { recursive: true });
    const write = () => fs.writeFileSync(path.join(root, "User", "globalStorage", "storage.json"), JSON.stringify(storage));
    write();
    expect(profileExtensionsFile(findMirroredProfile({ userDataRoot: root, vaultPath: vault }), "/ext")).toBe(path.join(root, "User", "profiles", "own1", "extensions.json"));
    storage.profileAssociations.workspaces[`file://${vault}`] = "agents1";
    write();
    expect(profileExtensionsFile(findMirroredProfile({ userDataRoot: root, vaultPath: vault }), "/ext")).toBe("/ext/extensions.json");
  });
});

// ---------------------------------------------------------------------------
// G10: the link set is rebuilt at every start
// ---------------------------------------------------------------------------

describe("G10: every symlink under <serverDataDir>/extensions is removed at each start, then exactly the enabled set is linked", () => {
  const share = (src: string, data: string, disabled: MirrorResult, entries: Array<[string, string]>) =>
    shareExtensions(src, data, enabledExtensions(stateOf(disabled, profileList(entries.map(([id, f]) => entry(src, id, f))))));

  it("after a profile change between two starts only the new profile's links exist", () => {
    const src = instanceFolder([TCL, PY, PYLANCE]);
    const data = tempDir();
    share(src, data, read([]), [["chakrounanas.turbo-console-log", TCL], ["ms-python.python", PY]]);
    expect(shared(data).links).toEqual([PY, TCL].sort());
    share(src, data, read([]), [["ms-python.vscode-pylance", PYLANCE]]);
    expect(shared(data)).toMatchObject({ links: [PYLANCE], listed: [PYLANCE] });
  });

  it("a link for an extension now disabled is gone", () => {
    const src = instanceFolder([TCL, PY]);
    const data = tempDir();
    const list: Array<[string, string]> = [["chakrounanas.turbo-console-log", TCL], ["ms-python.python", PY]];
    share(src, data, read([]), list);
    share(src, data, read(["ms-python.python"]), list);
    expect(shared(data)).toMatchObject({ links: [TCL], listed: [TCL] });
  });

  it("a link for an extension now uninstalled (folder removed) is gone, and so is its entry", () => {
    const src = instanceFolder([TCL, PY]);
    const data = tempDir();
    const list: Array<[string, string]> = [["chakrounanas.turbo-console-log", TCL], ["ms-python.python", PY]];
    share(src, data, read([]), list);
    fs.rmSync(path.join(src, PY), { recursive: true });
    share(src, data, read([]), [["chakrounanas.turbo-console-log", TCL]]);
    expect(shared(data)).toMatchObject({ links: [TCL], listed: [TCL] });
  });

  it("nothing readable on the next start removes every link", () => {
    const src = instanceFolder([TCL]);
    const data = tempDir();
    share(src, data, read([]), [["chakrounanas.turbo-console-log", TCL]]);
    share(src, data, none, [["chakrounanas.turbo-console-log", TCL]]);
    expect(shared(data)).toMatchObject({ links: [], raw: "[]" });
  });

  it("with no extensions folder at all, stale links are still removed and the list is []", () => {
    const src = instanceFolder([TCL]);
    const data = tempDir();
    share(src, data, read([]), [["chakrounanas.turbo-console-log", TCL]]);
    shareExtensions(null, data, []);
    expect(shared(data)).toMatchObject({ links: [], raw: "[]" });
  });

  it("only symlinks are unlinked: a real file or folder in the plugin's folder survives, and the instance's folder is byte-identical", () => {
    const src = instanceFolder([TCL, PY]);
    const data = tempDir();
    const target = path.join(data, "extensions");
    fs.mkdirSync(path.join(target, "real-dir"), { recursive: true });
    fs.writeFileSync(path.join(target, "real-dir", "keep.txt"), "mine");
    fs.writeFileSync(path.join(target, "note.txt"), "mine too");
    // a stale link to the instance's folder, and one to somewhere else entirely
    fs.symlinkSync(path.join(src, PY), path.join(target, "stale-instance-link"), "dir");
    const elsewhere = tempDir();
    fs.writeFileSync(path.join(elsewhere, "precious.txt"), "precious");
    fs.symlinkSync(elsewhere, path.join(target, "stale-elsewhere-link"), "dir");
    const before = treeDigest(src);
    share(src, data, read([]), [["chakrounanas.turbo-console-log", TCL]]);
    expect(fs.readdirSync(target).sort()).toEqual([TCL, "extensions.json", "note.txt", "real-dir"].sort());
    expect(fs.readFileSync(path.join(target, "real-dir", "keep.txt"), "utf8")).toBe("mine");
    expect(fs.readFileSync(path.join(elsewhere, "precious.txt"), "utf8")).toBe("precious");
    expect(treeDigest(src)).toBe(before);
    expect(fs.existsSync(path.join(src, PY, "package.json"))).toBe(true);
  });

  it("a name that a real folder in the plugin's folder already holds is neither linked nor listed", () => {
    const src = instanceFolder([TCL]);
    const data = tempDir();
    fs.mkdirSync(path.join(data, "extensions", TCL), { recursive: true });
    share(src, data, read([]), [["chakrounanas.turbo-console-log", TCL]]);
    expect(shared(data)).toMatchObject({ links: [], raw: "[]" });
    expect(fs.lstatSync(path.join(data, "extensions", TCL)).isDirectory()).toBe(true);
  });

  it("an extensions.json that an earlier run left as a symlink is replaced, never written through to its target", () => {
    const src = instanceFolder([TCL]);
    const data = tempDir();
    fs.mkdirSync(path.join(data, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(src, "extensions.json"), "ORIGINAL");
    fs.symlinkSync(path.join(src, "extensions.json"), path.join(data, "extensions", "extensions.json"));
    share(src, data, read([]), [["chakrounanas.turbo-console-log", TCL]]);
    expect(fs.readFileSync(path.join(src, "extensions.json"), "utf8")).toBe("ORIGINAL");
    expect(fs.lstatSync(path.join(data, "extensions", "extensions.json")).isSymbolicLink()).toBe(false);
    expect(shared(data).listed).toEqual([TCL]);
  });
});

// ---------------------------------------------------------------------------
// E5
// ---------------------------------------------------------------------------

describe("E5: dangling links and extensions removed after the start", () => {
  const list = (src: string): Array<Record<string, unknown>> => [entry(src, "chakrounanas.turbo-console-log", TCL), entry(src, "ms-python.python", PY)];

  it("a dangling symlink in the instance's folder is skipped: the start's sharing succeeds and writes no entry for it", () => {
    const src = instanceFolder([TCL]);
    fs.symlinkSync(path.join(src, "gone-for-good"), path.join(src, PY), "dir"); // the profile lists PY, whose folder is a dead link
    const data = tempDir();
    expect(() => shareExtensions(src, data, enabledExtensions(stateOf(read([]), profileList(list(src)))))).not.toThrow();
    expect(shared(data)).toMatchObject({ links: [TCL], listed: [TCL] });
  });

  it("a folder removed after the start leaves the links and extensions.json as they were; the read-only helper names the dead link", () => {
    const src = instanceFolder([TCL, PY]);
    const data = tempDir();
    shareExtensions(src, data, enabledExtensions(stateOf(read([]), profileList(list(src)))));
    const before = shared(data);
    expect(danglingSharedLinks(data)).toEqual([]);
    fs.rmSync(path.join(src, PY), { recursive: true });
    expect(danglingSharedLinks(data)).toEqual([PY]);
    expect(shared(data)).toEqual(before); // nothing was touched
    expect(danglingSharedLinks(data)).toEqual([PY]); // asking changes nothing either
  });

  it("removed mid-session, then the next start: the link and the entry are gone", () => {
    const src = instanceFolder([TCL, PY]);
    const data = tempDir();
    const file = profileList(list(src));
    shareExtensions(src, data, enabledExtensions(stateOf(read([]), file)));
    fs.rmSync(path.join(src, PY), { recursive: true });
    shareExtensions(src, data, enabledExtensions(stateOf(read([]), file)));
    expect(shared(data)).toMatchObject({ links: [TCL], listed: [TCL] });
    expect(danglingSharedLinks(data)).toEqual([]);
  });

  it("the helper lists only links: a real folder or file is never reported, and a missing folder is []", () => {
    const data = tempDir();
    expect(danglingSharedLinks(path.join(data, "none"))).toEqual([]);
    fs.mkdirSync(path.join(data, "extensions", "real"), { recursive: true });
    fs.writeFileSync(path.join(data, "extensions", "file.txt"), "x");
    expect(danglingSharedLinks(data)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F1, F9: nothing outside the plugin's folder changes
// ---------------------------------------------------------------------------

describe("F1/F9: the instance and its profile files are only read", () => {
  it("a read-only instance tree and profile tree have identical listing and checksums after a share, a second share and a share with a new set", () => {
    const home = tempDir();
    const src = path.join(home, ".vscode-insiders", "extensions");
    for (const n of [TCL, PY]) {
      fs.mkdirSync(path.join(src, n), { recursive: true });
      fs.writeFileSync(path.join(src, n, "package.json"), "{}");
    }
    const userData = path.join(home, "Application Support", "Code - Insiders", "User");
    fs.mkdirSync(path.join(userData, "globalStorage"), { recursive: true });
    fs.mkdirSync(path.join(userData, "profiles", "p1"), { recursive: true });
    fs.writeFileSync(path.join(userData, "globalStorage", "storage.json"), "{}");
    fs.writeFileSync(path.join(userData, "globalStorage", "state.vscdb"), "db");
    const profileFile = path.join(userData, "profiles", "p1", "extensions.json");
    fs.writeFileSync(profileFile, JSON.stringify([entry(src, "chakrounanas.turbo-console-log", TCL), entry(src, "ms-python.python", PY)]));
    // a second instance (F9) with its own folder and settings
    const other = path.join(home, ".vscode", "extensions");
    fs.mkdirSync(path.join(other, "x.y-1.0.0"), { recursive: true });
    fs.writeFileSync(path.join(other, "extensions.json"), "[]");
    fs.writeFileSync(path.join(home, "Application Support", "settings-other.json"), "{}");
    makeReadOnly(home);
    writable.push(home);

    const before = treeDigest(home);
    const data = tempDir(); // the plugin's own folder is writable
    shareExtensions(src, data, enabledExtensions(stateOf(read([]), profileFile)));
    shareExtensions(src, data, enabledExtensions(stateOf(read(["ms-python.python"]), profileFile)));
    shareExtensions(src, data, enabledExtensions(stateOf(none, profileFile)));
    expect(treeDigest(home)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// F2, F7: what the changed files may contain
// ---------------------------------------------------------------------------

describe("F2/F7: no install/update/enable/disable code path and no re-read trigger in the changed source", () => {
  const code = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), "utf8").replace(/^\s*(\*|\/\/|\/\*).*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  it("F2: the new module and the sharing code in server.ts define and call nothing named install, uninstall, update, enable or disable", () => {
    const verbs = /\b(un)?install\w*\s*\(|\bupdate\w*\s*\(|\benable\s*\(|\bdisable\s*\(|\b(enable|disable)Extension\w*|\b(un)?installExtension\w*/i;
    for (const f of ["src/server/shared-extensions.ts"]) expect(code(f), f).not.toMatch(verbs);
    const server = code("src/server.ts");
    const start = server.indexOf("export function shareExtensions");
    const end = server.indexOf("export function findFreePort");
    expect(server.slice(start, end)).not.toMatch(verbs);
  });

  it("F2: the new module writes nothing; shareExtensions writes only under <serverDataDir>/extensions (a link is made at dst, the instance path is only ever the link target)", () => {
    expect(code("src/server/shared-extensions.ts")).not.toMatch(/\.(writeFile|appendFile|rename|unlink|rm|symlink|mkdir|chmod|copyFile)\w*\(/);
    const server = code("src/server.ts");
    const body = server.slice(server.indexOf("export function shareExtensions"), server.indexOf("export function findFreePort"));
    const writes = body.match(/fs\.(unlinkSync|symlinkSync|writeFileSync|mkdirSync|rmSync|renameSync)\([^;]*/g) ?? [];
    expect(writes).toEqual([
      "fs.mkdirSync(target, { recursive: true })",
      "fs.unlinkSync(p)",
      'fs.symlinkSync(src, dst, "dir")',
      "fs.writeFileSync(path.join(target, EXTENSIONS_LIST_FILE), rewriteExtensionsJson(JSON.stringify(shared), target))",
    ]);
  });

  it("F7: no watcher or timer in the new module, and the start path is the only place the mirror state is read", () => {
    expect(code("src/server/shared-extensions.ts")).not.toMatch(/\bwatch\w*\(|setInterval|setTimeout|chokidar/);
    const main = code("src/main.ts");
    expect(main.match(/readProfileExtensions|reuseMirror/g) ?? []).toEqual(["reuseMirror"]);
  });
});
