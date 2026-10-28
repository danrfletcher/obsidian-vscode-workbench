/**
 * Integration: the mirrored profile against a fake Application Support root made by
 * tests/fixtures/make-fake-user-data.mjs (the real `fs` on a temp dir, `storage.json` in the shape desktop VS Code
 * writes it). `WORKBENCH_APP_SUPPORT_ROOT` points at the root, as it does for the plugin.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWN_BUILDS, appSupportRoot } from "../../src/instances/scan";
import { findMirroredProfile, profileForInstance, type ProfileFs, type ProfileState } from "../../src/profile/mirrored-profile";
import { BUILD_FOLDERS, PROFILES, makeFakeUserData, vscodeFolderUri, writeUserData } from "../fixtures/make-fake-user-data.mjs";
import { tempDir } from "../helpers";

const VAULT = "/Users/x/My Vault/Café Ünï";
const VAULT_KEY = vscodeFolderUri(VAULT);

afterEach(() => vi.unstubAllEnvs());

/** A fake root with a different association in each build's folder, and the root made current. */
function rootWithDistinctBuilds(): { appSupport: string; expected: Record<string, { name: string; fallback: boolean }> } {
  const appSupport = tempDir();
  const plan: Record<string, { association: string | null; name: string; fallback: boolean }> = {
    Code: { association: PROFILES.custom.location, name: "FDE Practice", fallback: false },
    "Code - Insiders": { association: PROFILES.agents.location, name: "Agents", fallback: false },
    VSCodium: { association: "__default__profile__", name: "Default", fallback: false },
    Antigravity: { association: "ffff0000", name: "Default", fallback: true },
    "Antigravity IDE": { association: PROFILES.deleted.location, name: "Default", fallback: true },
  };
  for (const [folder, p] of Object.entries(plan)) writeUserData(path.join(appSupport, folder), { associations: p.association ? { [VAULT_KEY]: p.association } : {} });
  vi.stubEnv("WORKBENCH_APP_SUPPORT_ROOT", appSupport);
  return { appSupport, expected: Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, { name: v.name, fallback: v.fallback }])) };
}

/** A file system that records the path of every call, and does the real thing. */
function recordingFs(): { io: ProfileFs; touched: string[] } {
  const touched: string[] = [];
  const io: ProfileFs = {
    readFileSync: (f, e) => (touched.push(f), fs.readFileSync(f, e)),
    statSync: (f) => (touched.push(f), fs.statSync(f)),
  };
  return { io, touched };
}

/** Every file and folder under `dir`: bytes (files) and mtime. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      if (e.isDirectory()) {
        out[p] = `dir ${st.mtimeMs}`;
        walk(p);
      } else {
        out[p] = `file ${st.mtimeMs} ${st.size} ${fs.readFileSync(p).toString("base64")}`;
      }
    }
  };
  walk(dir);
  return out;
}

/** Give every file under `dir` an old mtime, so a rewrite (which would set the time to now) cannot hide. */
function age(dir: string): void {
  const old = new Date("2020-01-01T00:00:00Z");
  for (const [p, kind] of Object.entries(snapshot(dir))) if (kind.startsWith("file")) fs.utimesSync(p, old, old);
}

describe("the fixture, as desktop VS Code would write it", () => {
  it("has Default, a custom profile, a useDefaultFlags profile and a deleted profile", () => {
    const { roots } = makeFakeUserData(tempDir(), { associations: { [VAULT_KEY]: PROFILES.custom.location } });
    const user = path.join(roots["Code - Insiders"], "User");
    const storage = JSON.parse(fs.readFileSync(path.join(user, "globalStorage", "storage.json"), "utf8"));
    expect(storage.userDataProfiles.map((p: { name: string }) => p.name)).toEqual(["FDE Practice", "Agents", "Old Profile"]);
    expect(storage.userDataProfiles[1].useDefaultFlags).toEqual({ settings: true, keybindings: true });
    expect(storage.profileAssociations.workspaces).toEqual({ "file:///Users/x/My%20Vault/Caf%C3%A9%20%C3%9Cn%C3%AF": "5c6b7f1e" });
    expect(fs.existsSync(path.join(user, "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(user, "profiles", "5c6b7f1e", "settings.json"))).toBe(true);
    expect(fs.existsSync(path.join(user, "profiles", "agents-7a2d", "extensions.json"))).toBe(true);
    expect(fs.existsSync(path.join(user, "profiles", "d3adbeef"))).toBe(false);
  });

  it("covers every build in KNOWN_BUILDS", () => {
    expect([...BUILD_FOLDERS].sort()).toEqual(KNOWN_BUILDS.map((b) => b.userDataName).sort());
  });
});

describe("E6: the profile comes from the chosen instance's own user-data folder, whichever build it is", () => {
  it.each(KNOWN_BUILDS.map((b) => [b.label, b] as const))("%s", (_label, build) => {
    const { appSupport, expected } = rootWithDistinctBuilds();
    const { io, touched } = recordingFs();
    const state = profileForInstance({ instance: { kind: build.kind, userDataName: build.userDataName }, vaultPath: VAULT, appSupport: appSupportRoot(), fs: io });
    expect(state.status).toBe("resolved");
    const profile = (state as Extract<ProfileState, { status: "resolved" }>).profile;
    expect(profile.name).toBe(expected[build.userDataName].name);
    expect(profile.fallback).toBe(expected[build.userDataName].fallback);
    const own = path.join(appSupport, build.userDataName);
    expect(profile.dir.startsWith(own + path.sep)).toBe(true);
    // F9: every path opened is inside this build's own folder; the other builds' folders are never opened.
    expect(touched.length).toBeGreaterThan(0);
    for (const p of touched) expect(p.startsWith(own + path.sep)).toBe(true);
    for (const other of BUILD_FOLDERS.filter((f) => f !== build.userDataName)) {
      expect(touched.some((p) => p.startsWith(path.join(appSupport, other) + path.sep))).toBe(false);
    }
  });

  it("the folders are told apart by name: 'Code' does not read 'Code - Insiders'", () => {
    const { appSupport } = rootWithDistinctBuilds();
    const { io, touched } = recordingFs();
    profileForInstance({ instance: { kind: "vscode", userDataName: "Code" }, vaultPath: VAULT, appSupport, fs: io });
    expect(touched.some((p) => p.includes("Code - Insiders"))).toBe(false);
  });

  it("a custom CLI with a configured folder reads that folder only", () => {
    const { appSupport } = rootWithDistinctBuilds();
    writeUserData(path.join(appSupport, "My Code"), { associations: { [VAULT_KEY]: PROFILES.custom.location } });
    const { io, touched } = recordingFs();
    const state = profileForInstance({ instance: { kind: "custom", userDataName: null }, vaultPath: VAULT, appSupport, configuredFolder: "My Code", fs: io });
    expect(state.status === "resolved" && state.profile.name).toBe("FDE Practice");
    for (const p of touched) expect(p.startsWith(path.join(appSupport, "My Code") + path.sep)).toBe(true);
  });

  it("a custom CLI whose folder cannot be told reports that, and opens nothing", () => {
    const { appSupport } = rootWithDistinctBuilds();
    const { io, touched } = recordingFs();
    const state = profileForInstance({ instance: { kind: "custom", userDataName: null }, vaultPath: VAULT, appSupport, fs: io });
    expect(state.status).toBe("unavailable");
    expect(touched).toEqual([]);
  });

  it("an instance whose folder is not in the root: Default, the file reported missing, and nothing else in the root opened", () => {
    const { appSupport } = rootWithDistinctBuilds();
    const { io, touched } = recordingFs();
    const state = profileForInstance({ instance: { kind: "custom", userDataName: "Not Installed" }, vaultPath: VAULT, appSupport, fs: io });
    expect(state.status === "resolved" && state.profile.reason).toBe("desktop VS Code's storage.json could not be read (the file is missing), so Default is used");
    for (const p of touched) expect(p.startsWith(path.join(appSupport, "Not Installed") + path.sep)).toBe(true);
  });
});

describe("F1: nothing under User/ is written, created or touched", () => {
  const associations = [
    ["a custom profile", PROFILES.custom.location],
    ["a useDefaultFlags profile", PROFILES.agents.location],
    ["Default", "__default__profile__"],
    ["an unknown profile", "ffff0000"],
    ["a deleted profile", PROFILES.deleted.location],
  ] as const;

  it.each(associations)("a lookup with the vault associated to %s changes no byte, no mtime and creates no file", (_name, id) => {
    const { roots } = makeFakeUserData(tempDir(), { associations: { [VAULT_KEY]: id }, folders: ["Code - Insiders"] });
    const root = roots["Code - Insiders"];
    age(root);
    const before = snapshot(path.join(root, "User"));
    findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
    findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
    expect(snapshot(path.join(root, "User"))).toEqual(before);
  });

  it("a damaged storage.json is left as it was, not repaired", () => {
    const { roots } = makeFakeUserData(tempDir(), { folders: ["Code - Insiders"] });
    const root = roots["Code - Insiders"];
    fs.writeFileSync(path.join(root, "User", "globalStorage", "storage.json"), "{ not json");
    age(root);
    const before = snapshot(path.join(root, "User"));
    findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
    expect(snapshot(path.join(root, "User"))).toEqual(before);
  });

  it("the module has no way to write: the file system it is given has no write call, and it still answers", () => {
    const { roots } = makeFakeUserData(tempDir(), { associations: { [VAULT_KEY]: PROFILES.custom.location }, folders: ["Code - Insiders"] });
    const readOnly: ProfileFs = { readFileSync: (f, e) => fs.readFileSync(f, e), statSync: (f) => fs.statSync(f) };
    expect(Object.keys(readOnly).sort()).toEqual(["readFileSync", "statSync"]);
    expect(findMirroredProfile({ userDataRoot: roots["Code - Insiders"], vaultPath: VAULT, fs: readOnly }).name).toBe("FDE Practice");
  });
});

describe("the module opens only storage.json and the profile's folder", () => {
  it("a lookup with a custom profile opens storage.json and the profile folder, nothing else", () => {
    const { roots } = makeFakeUserData(tempDir(), { associations: { [VAULT_KEY]: PROFILES.custom.location }, folders: ["Code - Insiders"] });
    const root = roots["Code - Insiders"];
    const { io, touched } = recordingFs();
    findMirroredProfile({ userDataRoot: root, vaultPath: VAULT, fs: io });
    expect(touched).toEqual([path.join(root, "User", "globalStorage", "storage.json"), path.join(root, "User", "profiles", PROFILES.custom.location)]);
  });
});
