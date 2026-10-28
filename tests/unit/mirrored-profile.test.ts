import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE_LOCATION,
  findMirroredProfile,
  normaliseFolderUri,
  profileForInstance,
  userDataRootFor,
  type MirroredProfile,
} from "../../src/profile/mirrored-profile";
import { PROFILES, vscodeFolderUri, writeUserData } from "../fixtures/make-fake-user-data.mjs";
import { tempDir } from "../helpers";

/** The vault of the examples: spaces and non-ASCII characters in the path (E10). */
const VAULT = "/Users/x/My Vault/Café Ünï";
const VAULT_URI = "file:///Users/x/My Vault/Café Ünï";
const VAULT_ENCODED = "file:///Users/x/My%20Vault/Caf%C3%A9%20%C3%9Cn%C3%AF";

/** A user-data folder (`<tmp>/Code - Insiders`) with the fixture's profiles and the given associations. */
function userData(associations: Record<string, string>): string {
  return writeUserData(path.join(tempDir(), "Code - Insiders"), { associations });
}

function storageFile(root: string): string {
  return path.join(root, "User", "globalStorage", "storage.json");
}

function find(associations: Record<string, string>, vaultPath = VAULT): MirroredProfile {
  const root = userData(associations);
  return findMirroredProfile({ userDataRoot: root, vaultPath });
}

describe("normaliseFolderUri", () => {
  it.each([
    ["a plain path", "/Users/x/Vault", "file:///Users/x/Vault"],
    ["a path with spaces", "/Users/x/My Vault", "file:///Users/x/My Vault"],
    ["a path with non-ASCII characters", VAULT, VAULT_URI],
    ["a path with a trailing slash", "/Users/x/Vault/", "file:///Users/x/Vault"],
    ["a path with doubled slashes", "/Users//x///Vault", "file:///Users/x/Vault"],
    ["an unencoded URI", VAULT_URI, VAULT_URI],
    ["an encoded URI (%20 and encoded non-ASCII)", VAULT_ENCODED, VAULT_URI],
    ["an encoded URI with a trailing slash", `${VAULT_ENCODED}/`, VAULT_URI],
    ["a URI with the scheme in capitals", "FILE:///Users/x/Vault", "file:///Users/x/Vault"],
    ["a URI with a localhost authority", "file://localhost/Users/x/Vault", "file:///Users/x/Vault"],
    ["a URI with a drive letter whose colon is encoded", "file:///c%3A/Users/x/Vault", "file:///c:/Users/x/Vault"],
    ["a URI with a drive letter in capitals and a plain colon", "file:///C:/Users/x/Vault", "file:///c:/Users/x/Vault"],
    ["a Windows path", "C:\\Users\\x\\Vault", "file:///c:/Users/x/Vault"],
    ["a malformed escape, compared as written", "file:///Users/x/100%zz", "file:///Users/x/100%zz"],
    ["Unicode in the decomposed form (a macOS file name)", "/Users/x/Cafe\u0301", "file:///Users/x/Caf\u00e9"],
    ["an encoded decomposed name", "file:///Users/x/Cafe%CC%81", "file:///Users/x/Caf\u00e9"],
    ["a URI with a query and a fragment, which are dropped", "file:///Users/x/Vault?a=1#b", "file:///Users/x/Vault"],
    ["a dot segment", "/Users/x/./Vault", "file:///Users/x/Vault"],
    ["the root", "/", "file:///"],
  ])("%s", (_name, input, expected) => {
    expect(normaliseFolderUri(input)).toBe(expected);
  });

  it("a path is not decoded (a folder literally named 100%25 stays that), a URI is", () => {
    expect(normaliseFolderUri("/Users/x/100%25")).toBe("file:///Users/x/100%25");
    expect(normaliseFolderUri("file:///Users/x/100%25")).toBe("file:///Users/x/100%");
  });

  it("an encoded and an unencoded form of the same folder come out equal", () => {
    expect(normaliseFolderUri(VAULT_ENCODED)).toBe(normaliseFolderUri(VAULT_URI));
    expect(normaliseFolderUri(VAULT_ENCODED)).toBe(normaliseFolderUri(VAULT));
  });
});

describe("the match rule (G15, nearest parent)", () => {
  it.each([
    ["the vault folder, written unencoded", VAULT_URI],
    ["the vault folder, written encoded", VAULT_ENCODED],
    ["the vault folder, with a trailing slash", `${VAULT_ENCODED}/`],
    ["the vault folder, with the scheme in capitals", "FILE:///Users/x/My%20Vault/Caf%C3%A9%20%C3%9Cn%C3%AF"],
    ["the vault folder, in the decomposed Unicode form", "file:///Users/x/My%20Vault/Cafe%CC%81%20U%CC%88ni%CC%88"],
  ])("an association written as %s matches the vault path", (_name, key) => {
    const p = find({ [key]: PROFILES.custom.location });
    expect(p.name).toBe("FDE Practice");
    expect(p.chosenFrom).toBe("vault-folder");
    expect(p.fallback).toBe(false);
    expect(p.matchedUri).toBe(VAULT_URI);
  });

  it("the vault path is matched in either Unicode form", () => {
    const p = find({ [VAULT_ENCODED]: PROFILES.custom.location }, "/Users/x/My Vault/Cafe\u0301 U\u0308ni\u0308");
    expect(p.name).toBe("FDE Practice");
  });

  it("a vault given as a URI is matched too", () => {
    expect(find({ [VAULT_ENCODED]: PROFILES.custom.location }, VAULT_ENCODED).name).toBe("FDE Practice");
  });

  it("with an association on the vault folder and on a parent, the vault folder wins", () => {
    const p = find({ "file:///Users/x/My%20Vault": PROFILES.agents.location, [VAULT_ENCODED]: PROFILES.custom.location });
    expect(p.name).toBe("FDE Practice");
    expect(p.chosenFrom).toBe("vault-folder");
  });

  it("the vault folder wins whatever order the associations are written in", () => {
    const p = find({ [VAULT_ENCODED]: PROFILES.custom.location, "file:///Users/x/My%20Vault": PROFILES.agents.location });
    expect(p.name).toBe("FDE Practice");
  });

  it("with associations on two parents, the nearest parent wins", () => {
    const p = find({ "file:///Users/x": PROFILES.agents.location, "file:///Users/x/My%20Vault": PROFILES.custom.location });
    expect(p.name).toBe("FDE Practice");
    expect(p.chosenFrom).toBe("parent-folder");
    expect(p.matchedUri).toBe("file:///Users/x/My Vault");
  });

  it("an association on a parent only: that profile, chosen from the parent folder, with the parent named", () => {
    const p = find({ "file:///Users/x": PROFILES.custom.location });
    expect(p.name).toBe("FDE Practice");
    expect(p.chosenFrom).toBe("parent-folder");
    expect(p.matchedUri).toBe("file:///Users/x");
    expect(p.fallback).toBe(false);
    expect(p.reason).toBe('a parent folder (file:///Users/x) is associated with profile "FDE Practice" in desktop VS Code');
  });

  it("a folder that only shares a name prefix with the vault is not a parent", () => {
    const p = find({ "file:///Users/x/My": PROFILES.custom.location, "file:///Users/x/My%20Vault/Caf": PROFILES.custom.location });
    expect(p.name).toBe("Default");
    expect(p.fallback).toBe(true);
  });

  it("a folder below the vault, or a sibling, does not count", () => {
    const p = find({ [`${VAULT_ENCODED}/Notes`]: PROFILES.custom.location, "file:///Users/x/Other": PROFILES.custom.location });
    expect(p.fallback).toBe(true);
  });

  it("an association whose value is not a string is skipped, and the next parent is used", () => {
    const root = userData({});
    const file = storageFile(root);
    const storage = JSON.parse(fs.readFileSync(file, "utf8"));
    storage.profileAssociations.workspaces = { [VAULT_ENCODED]: 7, "file:///Users/x": PROFILES.custom.location };
    fs.writeFileSync(file, JSON.stringify(storage));
    const p = findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
    expect(p.name).toBe("FDE Practice");
    expect(p.chosenFrom).toBe("parent-folder");
  });

  it("an association written with a drive-style colon encoding matches a Windows-style path", () => {
    const p = find({ "file:///c%3A/Users/x/Vault": PROFILES.custom.location }, "C:\\Users\\x\\Vault");
    expect(p.name).toBe("FDE Practice");
  });
});

describe("no association (G7)", () => {
  it("the vault and every parent have none: Default, with the note and the URI that was tried", () => {
    const p = find({ "file:///Users/y/Elsewhere": PROFILES.custom.location });
    expect(p.name).toBe("Default");
    expect(p.isDefault).toBe(true);
    expect(p.location).toBe(DEFAULT_PROFILE_LOCATION);
    expect(p.chosenFrom).toBe("default");
    expect(p.matchedUri).toBeNull();
    expect(p.fallback).toBe(true);
    expect(p.vaultUri).toBe(VAULT_URI);
    expect(p.reason).toBe(
      "the vault folder is not associated with a profile in desktop VS Code (vault URI tried: file:///Users/x/My Vault/Café Ünï), so Default is used",
    );
  });

  it("no associations at all", () => {
    expect(find({}).fallback).toBe(true);
  });

  it("profileAssociations without a workspaces entry is no association, not an unreadable file", () => {
    const root = userData({});
    fs.writeFileSync(storageFile(root), JSON.stringify({ userDataProfiles: [], profileAssociations: { emptyWindows: {} } }));
    const p = findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
    expect(p.reason).toContain("is not associated with a profile in desktop VS Code");
    expect(p.reason).not.toContain("could not be read");
  });
});

describe("an association to Default", () => {
  it("is Default with no fallback note, chosen from the vault folder", () => {
    const p = find({ [VAULT_ENCODED]: DEFAULT_PROFILE_LOCATION });
    expect(p.name).toBe("Default");
    expect(p.isDefault).toBe(true);
    expect(p.chosenFrom).toBe("vault-folder");
    expect(p.fallback).toBe(false);
    expect(p.reason).toBe("the vault folder is associated with the Default profile in desktop VS Code");
  });

  it("on a parent folder: chosen from the parent folder", () => {
    const p = find({ "file:///Users/x": DEFAULT_PROFILE_LOCATION });
    expect(p.chosenFrom).toBe("parent-folder");
    expect(p.fallback).toBe(false);
  });

  it("a Default association on the vault beats a custom profile on a parent", () => {
    const p = find({ [VAULT_ENCODED]: DEFAULT_PROFILE_LOCATION, "file:///Users/x": PROFILES.custom.location });
    expect(p.isDefault).toBe(true);
    expect(p.chosenFrom).toBe("vault-folder");
  });

  it("Default's files: settings and keybindings in User/, the extensions list outside the user-data folder", () => {
    const root = userData({ [VAULT_ENCODED]: DEFAULT_PROFILE_LOCATION });
    const p = findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
    expect(p.dir).toBe(path.join(root, "User"));
    expect(p.files).toEqual({
      extensions: { from: "default", dir: null },
      settings: { from: "default", dir: path.join(root, "User") },
      keybindings: { from: "default", dir: path.join(root, "User") },
    });
  });
});

describe("a profile that is deleted or unknown (G8, E2)", () => {
  it("an association naming a location missing from userDataProfiles: Default, with the location id", () => {
    const p = find({ [VAULT_ENCODED]: "ffff0000" });
    expect(p.name).toBe("Default");
    expect(p.fallback).toBe(true);
    expect(p.chosenFrom).toBe("default");
    expect(p.reason).toBe(
      'the vault folder is associated with profile location "ffff0000", which is not in desktop VS Code\'s list of profiles (it was deleted or is unknown), so Default is used',
    );
  });

  it("on a parent folder the reason names the parent", () => {
    const p = find({ "file:///Users/x": "ffff0000" });
    expect(p.reason).toBe(
      'a parent folder (file:///Users/x) is associated with profile location "ffff0000", which is not in desktop VS Code\'s list of profiles (it was deleted or is unknown), so Default is used',
    );
  });

  it("a profile listed in userDataProfiles whose folder under User/profiles/ is missing: Default, with the reason", () => {
    const p = find({ [VAULT_ENCODED]: PROFILES.deleted.location });
    expect(p.name).toBe("Default");
    expect(p.fallback).toBe(true);
    expect(p.reason).toBe(
      'the vault folder is associated with profile "Old Profile" (location "d3adbeef"), but its folder under User/profiles/ is missing, so Default is used',
    );
  });

  it("a profile whose folder is a file, not a folder, counts as missing", () => {
    const root = userData({ [VAULT_ENCODED]: PROFILES.custom.location });
    const dir = path.join(root, "User", "profiles", PROFILES.custom.location);
    fs.rmSync(dir, { recursive: true });
    fs.writeFileSync(dir, "x");
    expect(findMirroredProfile({ userDataRoot: root, vaultPath: VAULT }).reason).toContain("its folder under User/profiles/ is missing");
  });

  it.each(["../../elsewhere", "a/b", "..", "."])("a location that is not one folder name (%s) is unknown, and nothing outside User/profiles/ is looked at", (id) => {
    const root = userData({ [VAULT_ENCODED]: id });
    const file = storageFile(root);
    const storage = JSON.parse(fs.readFileSync(file, "utf8"));
    storage.userDataProfiles.push({ name: "Sneaky", location: id });
    fs.writeFileSync(file, JSON.stringify(storage));
    const p = findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
    expect(p.name).toBe("Default");
    expect(p.fallback).toBe(true);
    expect(p.reason).toContain("not in desktop VS Code's list of profiles");
  });

  it("an association written for a parent still falls back when that profile is gone, even if another parent names a real one", () => {
    // The nearest association is the one used; its profile is gone, so it is Default (the farther one is not tried).
    const p = find({ "file:///Users/x/My%20Vault": "ffff0000", "file:///Users/x": PROFILES.custom.location });
    expect(p.name).toBe("Default");
    expect(p.fallback).toBe(true);
  });
});

describe("a profile with useDefaultFlags (G9)", () => {
  /** A user-data folder whose one listed profile `flagged` has the given flags; `ownFiles` are the files in its folder. */
  function flagged(flags: Record<string, unknown> | undefined, makeFolder = true): { root: string; p: MirroredProfile } {
    const root = userData({ [VAULT_ENCODED]: "flagged-1" });
    const file = storageFile(root);
    const storage = JSON.parse(fs.readFileSync(file, "utf8"));
    storage.userDataProfiles.push({ name: "Flagged", location: "flagged-1", ...(flags ? { useDefaultFlags: flags } : {}) });
    fs.writeFileSync(file, JSON.stringify(storage));
    if (makeFolder) fs.mkdirSync(path.join(root, "User", "profiles", "flagged-1"), { recursive: true });
    return { root, p: findMirroredProfile({ userDataRoot: root, vaultPath: VAULT }) };
  }

  it("the built-in style profile of the fixture reads Default's settings and keybindings, and its own extensions", () => {
    const root = userData({ [VAULT_ENCODED]: PROFILES.agents.location });
    const p = findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
    const own = path.join(root, "User", "profiles", "agents-7a2d");
    expect(p.name).toBe("Agents");
    expect(p.fallback).toBe(false);
    expect(p.dir).toBe(own);
    expect(p.files).toEqual({
      extensions: { from: "profile", dir: own },
      settings: { from: "default", dir: path.join(root, "User") },
      keybindings: { from: "default", dir: path.join(root, "User") },
    });
    expect(p.reason).toBe('the vault folder is associated with profile "Agents" in desktop VS Code; it reads Default\'s settings, keybindings');
  });

  it.each<[string, Record<string, unknown>, string[]]>([
    ["extensions", { extensions: true }, ["extensions"]],
    ["settings", { settings: true }, ["settings"]],
    ["keybindings", { keybindings: true }, ["keybindings"]],
    ["settings and extensions", { settings: true, extensions: true }, ["extensions", "settings"]],
    ["nothing (every flag false)", { extensions: false, settings: false, keybindings: false }, []],
    ["kinds the tab does not mirror", { snippets: true, tasks: true, globalState: true }, []],
    ["a flag that is not exactly true", { settings: "yes", keybindings: 1 }, []],
  ])("flagged %s: those kinds come from Default, the rest from the profile's own folder", (_name, flags, fromDefault) => {
    const { root, p } = flagged(flags);
    const own = path.join(root, "User", "profiles", "flagged-1");
    expect(p.name).toBe("Flagged");
    expect(p.fallback).toBe(false);
    for (const kind of ["extensions", "settings", "keybindings"] as const) {
      if (fromDefault.includes(kind)) {
        expect(p.files[kind]).toEqual({ from: "default", dir: kind === "extensions" ? null : path.join(root, "User") });
      } else {
        expect(p.files[kind]).toEqual({ from: "profile", dir: own });
      }
    }
  });

  it("no useDefaultFlags at all: every file is the profile's own", () => {
    const { root, p } = flagged(undefined);
    const own = path.join(root, "User", "profiles", "flagged-1");
    expect(p.files).toEqual({ extensions: { from: "profile", dir: own }, settings: { from: "profile", dir: own }, keybindings: { from: "profile", dir: own } });
  });

  it("all three flagged: no folder of its own is needed, the profile is still named and everything is Default's", () => {
    const { root, p } = flagged({ extensions: true, settings: true, keybindings: true }, false);
    expect(p.name).toBe("Flagged");
    expect(p.fallback).toBe(false);
    expect(p.files).toEqual({
      extensions: { from: "default", dir: null },
      settings: { from: "default", dir: path.join(root, "User") },
      keybindings: { from: "default", dir: path.join(root, "User") },
    });
  });

  it("one kind of its own and no folder: Default, with the missing-folder reason", () => {
    const { p } = flagged({ settings: true, keybindings: true }, false);
    expect(p.fallback).toBe(true);
    expect(p.reason).toBe('the vault folder is associated with profile "Flagged" (location "flagged-1"), but its folder under User/profiles/ is missing, so Default is used');
  });
});

describe("the profile list as VS Code writes it", () => {
  function withProfiles(profiles: unknown): MirroredProfile {
    const root = userData({ [VAULT_ENCODED]: "loc-1" });
    const file = storageFile(root);
    const storage = JSON.parse(fs.readFileSync(file, "utf8"));
    storage.userDataProfiles = profiles;
    fs.writeFileSync(file, JSON.stringify(storage));
    fs.mkdirSync(path.join(root, "User", "profiles", "loc-1"), { recursive: true });
    return findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
  }

  it("a location written as a URI object takes its last segment", () => {
    expect(withProfiles([{ name: "Uri", location: { $mid: 1, path: "/Users/x/Library/Application Support/Code - Insiders/User/profiles/loc-1", scheme: "file" } }]).name).toBe("Uri");
  });

  it("a profile without a name is called by its location", () => {
    expect(withProfiles([{ location: "loc-1" }]).name).toBe("loc-1");
  });

  it("entries that are not profiles are skipped; a list that is not a list means the profile is unknown", () => {
    expect(withProfiles([null, 4, "x", { name: "No location" }, { name: "Right", location: "loc-1" }]).name).toBe("Right");
    expect(withProfiles("nope").fallback).toBe(true);
    expect(withProfiles(undefined).fallback).toBe(true);
  });
});

describe("storage.json that cannot be used", () => {
  const cases: Array<[string, (file: string) => void, string]> = [
    ["missing", (f) => fs.rmSync(f), "the file is missing"],
    ["empty", (f) => fs.writeFileSync(f, ""), "the file is empty"],
    ["only white space", (f) => fs.writeFileSync(f, " \n\t "), "the file is empty"],
    ["not valid JSON", (f) => fs.writeFileSync(f, '{ "profileAssociations": { '), "the file is not valid JSON"],
    ["a JSON array", (f) => fs.writeFileSync(f, "[]"), "the file does not hold a JSON object"],
    ["JSON null", (f) => fs.writeFileSync(f, "null"), "the file does not hold a JSON object"],
    ["without profileAssociations", (f) => fs.writeFileSync(f, '{ "userDataProfiles": [] }'), "it has no profileAssociations"],
    ["with profileAssociations that is not an object", (f) => fs.writeFileSync(f, '{ "profileAssociations": "x" }'), "it has no profileAssociations"],
    ["a folder, not a file", (f) => (fs.rmSync(f), fs.mkdirSync(f)), "the read failed: EISDIR"],
  ];

  it.each(cases)("%s: Default, and the reason says the file could not be read", (_name, damage, why) => {
    const root = userData({ [VAULT_ENCODED]: PROFILES.custom.location });
    damage(storageFile(root));
    const p = findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
    expect(p.name).toBe("Default");
    expect(p.fallback).toBe(true);
    expect(p.chosenFrom).toBe("default");
    expect(p.reason).toBe(`desktop VS Code's storage.json could not be read (${why}), so Default is used`);
  });

  it("a user-data folder that does not exist at all", () => {
    const p = findMirroredProfile({ userDataRoot: path.join(tempDir(), "No Such App"), vaultPath: VAULT });
    expect(p.reason).toBe("desktop VS Code's storage.json could not be read (the file is missing), so Default is used");
  });

  it.skipIf(process.getuid?.() === 0)("a permission-denied storage.json falls back without throwing, and says so", () => {
    const root = userData({ [VAULT_ENCODED]: PROFILES.custom.location });
    const file = storageFile(root);
    fs.chmodSync(file, 0o000);
    try {
      const p = findMirroredProfile({ userDataRoot: root, vaultPath: VAULT });
      expect(p.name).toBe("Default");
      expect(p.fallback).toBe(true);
      expect(p.reason).toBe("desktop VS Code's storage.json could not be read (permission denied), so Default is used");
    } finally {
      fs.chmodSync(file, 0o644);
    }
  });

  it("the reason never quotes the file's text", () => {
    const root = userData({});
    fs.writeFileSync(storageFile(root), '{"secret-token": "hunter2" ');
    expect(findMirroredProfile({ userDataRoot: root, vaultPath: VAULT }).reason).not.toContain("hunter2");
  });

  it("an fs that throws something unexpected still gives an answer", () => {
    const p = findMirroredProfile({
      userDataRoot: "/x",
      vaultPath: VAULT,
      fs: {
        readFileSync: () => {
          throw Object.assign(new Error("boom"), { code: "EIO" });
        },
        statSync: () => {
          throw new Error("no");
        },
      },
    });
    expect(p.reason).toBe("desktop VS Code's storage.json could not be read (the read failed: EIO), so Default is used");
  });
});

describe("the instance's own user-data folder (E6)", () => {
  const app = "/Support";

  it.each([
    ["VS Code", "vscode", "Code"],
    ["VS Code Insiders", "vscode-insiders", "Code - Insiders"],
    ["VSCodium", "vscodium", "VSCodium"],
    ["Antigravity", "antigravity", "Antigravity"],
    ["Antigravity IDE", "antigravity-ide", "Antigravity IDE"],
  ] as const)("%s: its own folder under Application Support", (_label, kind, name) => {
    expect(userDataRootFor({ instance: { kind, userDataName: name }, appSupport: app })).toEqual({ root: path.join(app, name) });
  });

  it("a custom CLI inside a known app takes that app's folder name", () => {
    expect(userDataRootFor({ instance: { kind: "vscodium", userDataName: "VSCodium" }, appSupport: app })).toEqual({ root: "/Support/VSCodium" });
  });

  it("a custom CLI with a folder name from its product.json uses it", () => {
    expect(userDataRootFor({ instance: { kind: "custom", userDataName: "Code - OSS" }, appSupport: app })).toEqual({ root: "/Support/Code - OSS" });
  });

  it("a custom CLI with a configured folder: a bare name sits under Application Support, an absolute path is used as is, and it wins over the product.json name", () => {
    expect(userDataRootFor({ instance: { kind: "custom", userDataName: "Code - OSS" }, appSupport: app, configuredFolder: " Mine " })).toEqual({ root: "/Support/Mine" });
    expect(userDataRootFor({ instance: { kind: "custom", userDataName: null }, appSupport: app, configuredFolder: "/data/Mine" })).toEqual({ root: "/data/Mine" });
  });

  it("a configured folder is for a custom CLI only", () => {
    expect(userDataRootFor({ instance: { kind: "vscode", userDataName: "Code" }, appSupport: app, configuredFolder: "Other" })).toEqual({ root: "/Support/Code" });
  });

  it("a configured folder that is neither a name nor an absolute path is refused, not guessed", () => {
    const r = userDataRootFor({ instance: { kind: "custom", userDataName: null }, appSupport: app, configuredFolder: "../Escape" });
    expect(r).toEqual({ reason: 'the userDataFolder set in data.json ("../Escape") is neither an absolute path nor a folder name' });
  });

  it("a custom CLI whose folder cannot be told: the state says so, and no folder is read", () => {
    const reads: string[] = [];
    const state = profileForInstance({
      instance: { kind: "custom", userDataName: null },
      vaultPath: VAULT,
      appSupport: app,
      fs: {
        readFileSync: (f) => (reads.push(f), ""),
        statSync: (f) => (reads.push(f), { isDirectory: () => true }),
      },
    });
    expect(state).toEqual({
      status: "unavailable",
      reason:
        'the user-data folder of this custom VS Code cannot be told (its product.json names none). Set "userDataFolder" in data.json to its folder name under Application Support, or to an absolute path',
    });
    expect(reads).toEqual([]);
  });

  it("a user-data name that is not one folder name is not joined onto the path", () => {
    for (const bad of ["../x", "a/b", "..", ""]) {
      expect("reason" in userDataRootFor({ instance: { kind: "custom", userDataName: bad }, appSupport: app })).toBe(true);
    }
  });

  it("resolved: the profile of that instance's folder", () => {
    const appSupport = tempDir();
    writeUserData(path.join(appSupport, "Code - Insiders"), { associations: { [VAULT_ENCODED]: PROFILES.custom.location } });
    const state = profileForInstance({ instance: { kind: "vscode-insiders", userDataName: "Code - Insiders" }, vaultPath: VAULT, appSupport });
    expect(state.status).toBe("resolved");
    expect(state.status === "resolved" && state.profile.name).toBe("FDE Practice");
  });
});
