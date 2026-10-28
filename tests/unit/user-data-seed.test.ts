import { build } from "esbuild";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WORKSPACE_EXCLUDE_FOLDERS,
  buildSettings,
  excludeGlobs,
  instanceUserDir,
  parseJsonc,
  profileSeedSource,
  seedUserData,
  stripJsonc,
  stripTrustKeys,
  writeAtomic,
} from "../../src/server/user-data-seed";
import { findMirroredProfile } from "../../src/profile/mirrored-profile";
import { PROFILES, TOGGLE_PANEL_KEY, TOGGLE_SIDEBAR_KEY, TRUST_KEYS, vscodeFolderUri, writeUserData } from "../fixtures/make-fake-user-data.mjs";
import { REPO_ROOT, tempDir } from "../helpers";

const EXCLUDE_KEYS = ["files.watcherExclude", "search.exclude"];

function setup(files: Record<string, string | Buffer> = {}) {
  const source = path.join(tempDir(), "Code - Insiders", "User");
  const userData = path.join(tempDir(), "data");
  fs.mkdirSync(source, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(source, name), content);
  const settings = () => JSON.parse(fs.readFileSync(path.join(userData, "User", "settings.json"), "utf8")) as Record<string, unknown>;
  return { source, userData, settings };
}

describe("the five workspace excludes (G16)", () => {
  it("names .git, .obsidian, Attachments, node_modules and _to_delete", () => {
    expect([...WORKSPACE_EXCLUDE_FOLDERS]).toEqual([".git", ".obsidian", "Attachments", "node_modules", "_to_delete"]);
    expect(excludeGlobs()).toEqual({
      "**/.git": true,
      "**/.obsidian": true,
      "**/Attachments": true,
      "**/node_modules": true,
      "**/_to_delete": true,
    });
  });

  it("puts them in files.watcherExclude and search.exclude of the written settings", () => {
    const { userData, settings } = setup();
    seedUserData({ userDataDir: userData, sourceUserDir: null });
    for (const key of EXCLUDE_KEYS) expect(settings()[key]).toEqual(excludeGlobs());
  });
});

describe("JSONC", () => {
  it("strips line and block comments and trailing commas, keeping strings intact", () => {
    const text = `{
      // line comment
      "a": "http://example.com/*not a comment*/", /* block */
      "b": [1, 2, 3,],
      "c": { "d": "x,}", },
    }`;
    expect(parseJsonc(text)).toEqual({ a: "http://example.com/*not a comment*/", b: [1, 2, 3], c: { d: "x,}" } });
  });

  it("handles a BOM and escaped quotes", () => {
    expect(parseJsonc('\uFEFF{"a": "say \\"hi\\" // not a comment"}')).toEqual({ a: 'say "hi" // not a comment' });
  });

  it("throws an error that never quotes the text", () => {
    for (const bad of ['{"token": "s3cret-value" oops}', '{"a": "unterminated', "{/* open", "[1,,2]"]) {
      let message = "";
      try {
        parseJsonc(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/not valid JSON/);
      expect(message).not.toContain("s3cret");
    }
    expect(stripJsonc("{}")).toBe("{}");
  });
});

describe("buildSettings: the merge", () => {
  it("a missing source gives the excludes only", () => {
    const r = buildSettings(null);
    expect(r.source).toBe("missing");
    expect(Object.keys(r.settings).sort()).toEqual(EXCLUDE_KEYS);
  });

  it("an empty or blank source gives the excludes only", () => {
    expect(buildSettings("").source).toBe("empty");
    const r = buildSettings("  \n\t ");
    expect(r.source).toBe("empty");
    expect(Object.keys(r.settings).sort()).toEqual(EXCLUDE_KEYS);
  });

  it("copies every key of a plain JSON source", () => {
    const r = buildSettings('{"editor.fontSize": 15, "python.analysis.typeCheckingMode": "basic", "nested": {"a": [1, 2]}}');
    expect(r.source).toBe("copied");
    expect(r.settings).toMatchObject({ "editor.fontSize": 15, "python.analysis.typeCheckingMode": "basic", nested: { a: [1, 2] } });
  });

  it("merges a JSONC source (comments, trailing commas) without losing the user's keys", () => {
    const r = buildSettings(`{
      // my font
      "editor.fontSize": 15, /* px */
      "terminal.integrated.fontFamily": "Menlo",
    }`);
    expect(r.source).toBe("copied");
    expect(r.settings["editor.fontSize"]).toBe(15);
    expect(r.settings["terminal.integrated.fontFamily"]).toBe("Menlo");
  });

  it("the excludes win over the copied values; the user's own patterns stay", () => {
    const r = buildSettings(
      JSON.stringify({
        "files.watcherExclude": { "**/.git": false, "**/node_modules": false, "**/build": true },
        "search.exclude": { "**/_to_delete": false, "**/dist": true },
      }),
    );
    expect(r.settings["files.watcherExclude"]).toEqual({ ...excludeGlobs(), "**/build": true });
    expect(r.settings["search.exclude"]).toEqual({ ...excludeGlobs(), "**/dist": true });
  });

  it("replaces an exclude setting that is not an object", () => {
    const r = buildSettings('{"files.watcherExclude": "nope", "search.exclude": [1]}');
    expect(r.settings["files.watcherExclude"]).toEqual(excludeGlobs());
    expect(r.settings["search.exclude"]).toEqual(excludeGlobs());
  });

  it.each([
    ["invalid JSON", '{"a": 1 "b": 2}'],
    ["an array", "[1, 2]"],
    ["a bare string", '"settings"'],
    ["null", "null"],
    ["a truncated file", '{"a": 1,'],
  ])("%s gives the excludes only and is reported invalid", (_n, text) => {
    const r = buildSettings(text);
    expect(r.source).toBe("invalid");
    expect(Object.keys(r.settings).sort()).toEqual(EXCLUDE_KEYS);
  });
});

describe("seedUserData: writing", () => {
  it("copies settings (excludes on top) and keybindings byte for byte into <user-data>/User", () => {
    const keybindings = Buffer.from('// mine\r\n[\r\n  { "key": "cmd+k", "command": "x" },\r\n]\r\n\u00e9', "utf8");
    const { source, userData, settings } = setup({ "settings.json": '{"editor.fontSize": 15}', "keybindings.json": keybindings });
    const r = seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(r).toMatchObject({ settings: "copied", keybindings: true, notice: null });
    expect(r.settingsFile).toBe(path.join(userData, "User", "settings.json"));
    expect(settings()).toMatchObject({ "editor.fontSize": 15, "files.watcherExclude": excludeGlobs() });
    expect(fs.readFileSync(r.keybindingsFile).equals(keybindings)).toBe(true);
  });

  it("hands back what the browser profile needs: the merged settings and the keybindings byte for byte (base64)", () => {
    const keybindings = Buffer.from('// mine\r\n[ { "key": "ctrl+alt+n", "command": "x" } ]\u00e9', "utf8");
    const { source, userData, settings } = setup({ "settings.json": '{"editor.fontSize": 15, "search.exclude": {"**/mine": true}}', "keybindings.json": keybindings });
    const r = seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(r.merged).toEqual(settings());
    expect(r.merged).toMatchObject({ "editor.fontSize": 15, "search.exclude": { "**/mine": true, ...excludeGlobs() } });
    expect(Buffer.from(r.keybindingsBase64 as string, "base64").equals(keybindings)).toBe(true);
    expect(seedUserData({ userDataDir: userData, sourceUserDir: null }).keybindingsBase64).toBeNull();
  });

  it("a missing source folder gives excludes only and no keybindings", () => {
    const { userData, settings } = setup();
    const r = seedUserData({ userDataDir: userData, sourceUserDir: path.join(tempDir(), "no", "User") });
    expect(r).toMatchObject({ settings: "missing", keybindings: false, notice: null });
    expect(Object.keys(settings()).sort()).toEqual(EXCLUDE_KEYS);
    expect(fs.existsSync(r.keybindingsFile)).toBe(false);
  });

  it("an unknown source (null) gives excludes only", () => {
    const { userData, settings } = setup();
    expect(seedUserData({ userDataDir: userData, sourceUserDir: null }).settings).toBe("missing");
    expect(Object.keys(settings()).sort()).toEqual(EXCLUDE_KEYS);
  });

  it("an empty settings.json gives excludes only", () => {
    const { source, userData, settings } = setup({ "settings.json": "" });
    expect(seedUserData({ userDataDir: userData, sourceUserDir: source }).settings).toBe("empty");
    expect(Object.keys(settings()).sort()).toEqual(EXCLUDE_KEYS);
  });

  it("an invalid settings.json gives excludes only plus a notice that quotes nothing from the file", () => {
    const { source, userData, settings } = setup({ "settings.json": '{"github.token": "s3cret" oops}' });
    const r = seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(r.settings).toBe("invalid");
    expect(r.notice).toMatch(/could not be read.*only the workspace excludes/);
    expect(r.notice).not.toContain("s3cret");
    expect(Object.keys(settings()).sort()).toEqual(EXCLUDE_KEYS);
    expect(fs.readFileSync(r.settingsFile, "utf8")).not.toContain("s3cret");
  });

  it("a settings.json that cannot be read (it is a folder) counts as invalid", () => {
    const { source, userData } = setup();
    fs.mkdirSync(path.join(source, "settings.json"));
    const r = seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(r.settings).toBe("invalid");
    expect(r.notice).not.toBeNull();
  });

  it("overwrites the previous copy at each start", () => {
    const { source, userData, settings } = setup({ "settings.json": '{"editor.fontSize": 15, "only.first": true}', "keybindings.json": "[1]" });
    seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(settings()["only.first"]).toBe(true);
    fs.writeFileSync(path.join(source, "settings.json"), '{"editor.fontSize": 18}');
    fs.writeFileSync(path.join(source, "keybindings.json"), "[2]");
    seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(settings()["editor.fontSize"]).toBe(18);
    expect(settings()).not.toHaveProperty("only.first");
    expect(fs.readFileSync(path.join(userData, "User", "keybindings.json"), "utf8")).toBe("[2]");
  });

  it("an edit made in the embed to the copy does not survive the next start", () => {
    const { source, userData, settings } = setup({ "settings.json": '{"editor.fontSize": 15}' });
    seedUserData({ userDataDir: userData, sourceUserDir: source });
    fs.writeFileSync(path.join(userData, "User", "settings.json"), '{"edited.in.embed": true}');
    seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(settings()).toMatchObject({ "editor.fontSize": 15 });
    expect(settings()).not.toHaveProperty("edited.in.embed");
  });

  it("removes the copied keybindings when the source no longer has any", () => {
    const { source, userData } = setup({ "keybindings.json": "[1]" });
    seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(fs.existsSync(path.join(userData, "User", "keybindings.json"))).toBe(true);
    fs.rmSync(path.join(source, "keybindings.json"));
    const r = seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(r.keybindings).toBe(false);
    expect(fs.existsSync(path.join(userData, "User", "keybindings.json"))).toBe(false);
  });

  it("creates the files private (0600) in a private folder (0700): they can hold the user's secrets", () => {
    const { source, userData } = setup({ "settings.json": "{}", "keybindings.json": "[]" });
    const r = seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(fs.statSync(r.settingsFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(r.keybindingsFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(userData, "User")).mode & 0o777).toBe(0o700);
  });
});

describe("seedUserData: symlinks and atomic writes (G17)", () => {
  it("follows a symlinked source by content: the copy is a regular file", () => {
    const real = tempDir();
    fs.writeFileSync(path.join(real, "my-settings.json"), '{"from.link": 1}');
    fs.writeFileSync(path.join(real, "my-keys.json"), "[3]");
    const { source, userData, settings } = setup();
    fs.symlinkSync(path.join(real, "my-settings.json"), path.join(source, "settings.json"));
    fs.symlinkSync(path.join(real, "my-keys.json"), path.join(source, "keybindings.json"));
    const r = seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(settings()["from.link"]).toBe(1);
    for (const f of [r.settingsFile, r.keybindingsFile]) expect(fs.lstatSync(f).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(r.keybindingsFile, "utf8")).toBe("[3]");
  });

  it("replaces a symlink left at the destination instead of writing through it", () => {
    const { source, userData } = setup({ "settings.json": '{"a": 1}' });
    const outside = path.join(tempDir(), "victim.json");
    fs.writeFileSync(outside, "untouched");
    fs.mkdirSync(path.join(userData, "User"), { recursive: true });
    fs.symlinkSync(outside, path.join(userData, "User", "settings.json"));
    seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    expect(fs.lstatSync(path.join(userData, "User", "settings.json")).isSymbolicLink()).toBe(false);
  });

  it("two starts running at the same time (two processes) never leave a half-written or temp file", async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 6000; i++) big[`setting.number.${i}`] = "x".repeat(40);
    const { source, userData } = setup({ "settings.json": JSON.stringify(big), "keybindings.json": "[" + "1,".repeat(200000) + "1]" });
    // The real module, bundled, run in two child processes so the two seeds really interleave.
    const work = tempDir();
    const bundle = path.join(work, "seed.mjs");
    await build({ entryPoints: [path.join(REPO_ROOT, "src/server/user-data-seed.ts")], bundle: true, platform: "node", format: "esm", outfile: bundle, logLevel: "silent" });
    const runner = path.join(work, "run.mjs");
    fs.writeFileSync(
      runner,
      `import { seedUserData } from ${JSON.stringify(bundle)};\nfor (let i = 0; i < 40; i++) seedUserData({ userDataDir: ${JSON.stringify(userData)}, sourceUserDir: ${JSON.stringify(source)} });\n`,
    );
    const file = path.join(userData, "User", "settings.json");
    const keys = path.join(userData, "User", "keybindings.json");
    let sawBad = false;
    let reads = 0;
    const reader = setInterval(() => {
      for (const [f, parse] of [
        [file, JSON.parse],
        [keys, JSON.parse],
      ] as const) {
        try {
          parse(fs.readFileSync(f, "utf8"));
          reads++;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") sawBad = true;
        }
      }
    }, 0);
    const run = () =>
      new Promise<number | null>((resolve) => {
        const c = spawn(process.execPath, [runner], { stdio: "ignore" });
        c.on("exit", (code) => resolve(code));
      });
    const codes = await Promise.all([run(), run()]);
    clearInterval(reader);
    expect(codes).toEqual([0, 0]);
    expect(reads).toBeGreaterThan(10);
    expect(sawBad).toBe(false);
    expect(fs.readdirSync(path.join(userData, "User")).sort()).toEqual(["keybindings.json", "settings.json"]);
  }, 60_000);

  it("writeAtomic goes through a temp name in the same folder, then a rename; a failure leaves the old file and no temp", () => {
    const dir = tempDir();
    const dest = path.join(dir, "settings.json");
    fs.writeFileSync(dest, "old");
    writeAtomic(dest, "new");
    expect(fs.readFileSync(dest, "utf8")).toBe("new");
    expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
    // renaming a file onto a directory fails: the original stays and the temp file is removed
    const asDir = path.join(dir, "sub");
    fs.mkdirSync(asDir);
    expect(() => writeAtomic(asDir, "x")).toThrow();
    expect(fs.readdirSync(dir).sort()).toEqual(["settings.json", "sub"]);
  });
});

describe("seedUserData: the destination (F3)", () => {
  it("refuses a source folder inside the plugin's user-data dir", () => {
    const userData = tempDir();
    expect(() => seedUserData({ userDataDir: userData, sourceUserDir: path.join(userData, "User") })).toThrow(/destination is inside the instance|inside the plugin/);
  });

  it("refuses a user-data dir inside the instance's own folder, and writes nothing there", () => {
    const source = tempDir();
    const userData = path.join(source, "inner");
    expect(() => seedUserData({ userDataDir: userData, sourceUserDir: source })).toThrow();
    expect(fs.existsSync(userData)).toBe(false);
  });

  it("writes only inside the user-data dir", () => {
    const { source, userData } = setup({ "settings.json": "{}", "keybindings.json": "[]" });
    fs.mkdirSync(userData, { recursive: true });
    const beside = fs.readdirSync(path.dirname(userData)).sort();
    const sourceBefore = fs.readdirSync(source).sort();
    seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(fs.readdirSync(path.dirname(userData)).sort()).toEqual(beside);
    expect(fs.readdirSync(source).sort()).toEqual(sourceBefore);
    expect(fs.readdirSync(userData)).toEqual(["User"]);
  });
});

describe("instanceUserDir", () => {
  it("joins Application Support, the instance's folder name and User", () => {
    expect(instanceUserDir("Code - Insiders", "/Users/d/Library/Application Support")).toBe("/Users/d/Library/Application Support/Code - Insiders/User");
  });

  it.each([null, "", ".", "..", "../Code", "a/b", "a\\b"])("returns null for %j", (name) => {
    expect(instanceUserDir(name, "/x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PR-6: trust keys (G12) and the mirrored profile as the source (G13)
// ---------------------------------------------------------------------------

describe("stripTrustKeys / buildSettings: no security.workspace.trust.* key is copied (G12)", () => {
  const FIVE = [
    "security.workspace.trust.enabled",
    "security.workspace.trust.startupPrompt",
    "security.workspace.trust.banner",
    "security.workspace.trust.untrustedFiles",
    "security.workspace.trust.emptyWindow",
  ];

  it.each(FIVE)("removes the known key %s", (key) => {
    const r = buildSettings(JSON.stringify({ [key]: false, "editor.fontSize": 15 }));
    expect(r.source).toBe("copied");
    expect(r.settings).not.toHaveProperty(key);
    expect(r.settings["editor.fontSize"]).toBe(15);
  });

  it("removes an unknown key under the prefix, including a deeper dotted one", () => {
    const r = buildSettings('{"security.workspace.trust.somethingNew": 1, "security.workspace.trust.a.b.c": 2, "editor.fontSize": 15}');
    expect(Object.keys(r.settings).sort()).toEqual(["editor.fontSize", ...EXCLUDE_KEYS].sort());
  });

  it.each([
    ["security.workspace.trusted", true],
    ["security.workspace.trust", { enabled: false }],
    ["security.workspace", 1],
    ["security.workspace", { trust: { enabled: false } }],
    ["security", { workspace: { trust: { enabled: false } } }],
    ["security", { "workspace.trust.enabled": false }],
    ["security.allowedUNCHosts", ["a"]],
    ["security.restrictUNCAccess", false],
    ["Security.Workspace.Trust.enabled", false],
    ["my.security.workspace.trust.enabled", false],
    ["editor.fontSize", 15],
  ])("keeps the near miss / other key %s unchanged", (key, value) => {
    const r = buildSettings(JSON.stringify({ [key]: value }));
    expect(r.settings[key]).toEqual(value);
  });

  it("only top-level dotted keys go: trust keys inside the user's own objects stay", () => {
    const nested = { "security.workspace.trust.enabled": false, other: 1 };
    const r = buildSettings(JSON.stringify({ "[python]": nested, "my.object": { "security.workspace.trust.enabled": true }, "security.workspace.trust.enabled": false }));
    expect(r.settings).not.toHaveProperty("security.workspace.trust.enabled");
    expect(r.settings["[python]"]).toEqual(nested);
    expect(r.settings["my.object"]).toEqual({ "security.workspace.trust.enabled": true });
  });

  it("works on JSONC: comments, trailing commas, a trust key after a comment", () => {
    const r = buildSettings(`{
      // trust off, please
      "security.workspace.trust.enabled": false, /* really */
      "security.workspace.trust.banner": "never",
      "security.workspace.trusted": "keep me", // near miss
      "editor.fontSize": 15,
    }`);
    expect(r.source).toBe("copied");
    expect(r.settings["security.workspace.trusted"]).toBe("keep me");
    expect(r.settings["editor.fontSize"]).toBe(15);
    expect(Object.keys(r.settings).some((k) => k.startsWith("security.workspace.trust."))).toBe(false);
  });

  it("keeps the user's other keys, the excludes and their own exclude patterns", () => {
    const r = buildSettings(JSON.stringify({ ...TRUST_KEYS, "files.watcherExclude": { "**/build": true }, "search.exclude": { "**/dist": true }, "update.mode": "start", "a.b": [1, { c: 2 }] }));
    expect(r.settings["files.watcherExclude"]).toEqual({ ...excludeGlobs(), "**/build": true });
    expect(r.settings["search.exclude"]).toEqual({ ...excludeGlobs(), "**/dist": true });
    expect(r.settings["update.mode"]).toBe("start");
    expect(r.settings["a.b"]).toEqual([1, { c: 2 }]);
  });

  it("settings holding only trust keys give the excludes only, a valid object (not empty, not invalid)", () => {
    const r = buildSettings(JSON.stringify(TRUST_KEYS));
    expect(r.source).toBe("copied");
    expect(Object.keys(r.settings).sort()).toEqual(EXCLUDE_KEYS);
    expect(r.settings["files.watcherExclude"]).toEqual(excludeGlobs());
  });

  it("stripTrustKeys is pure: it returns a new object and leaves its input alone", () => {
    const input = Object.freeze({ "security.workspace.trust.enabled": false, keep: 1 });
    const out = stripTrustKeys(input);
    expect(out).toEqual({ keep: 1 });
    expect(out).not.toBe(input);
    expect(input).toHaveProperty("security.workspace.trust.enabled");
  });

  it("seedUserData: the trust keys are in neither SeedResult.merged nor the file it wrote", () => {
    const { source, userData, settings } = setup({ "settings.json": JSON.stringify({ ...TRUST_KEYS, "editor.fontSize": 15 }) });
    const r = seedUserData({ userDataDir: userData, sourceUserDir: source });
    for (const obj of [r.merged, settings()]) {
      expect(Object.keys(obj).some((k) => k.startsWith("security.workspace.trust."))).toBe(false);
      expect(obj["editor.fontSize"]).toBe(15);
    }
    expect(fs.readFileSync(r.settingsFile, "utf8")).not.toContain("security.workspace.trust");
  });

  it("keybindings.json is copied byte for byte: a trust-key lookalike inside it is not touched", () => {
    const kb = Buffer.from('[{ "key": "a", "command": "x", "args": { "security.workspace.trust.enabled": false } }]');
    const { source, userData } = setup({ "settings.json": "{}", "keybindings.json": kb });
    const r = seedUserData({ userDataDir: userData, sourceUserDir: source });
    expect(fs.readFileSync(r.keybindingsFile).equals(kb)).toBe(true);
    expect(Buffer.from(r.keybindingsBase64 as string, "base64").equals(kb)).toBe(true);
  });
});

describe("seedUserData from a profile folder (G13)", () => {
  const vault = "/Users/x/Vault";
  const profileOf = (root: string) => findMirroredProfile({ userDataRoot: root, vaultPath: vault });
  const fixture = (association: string) => {
    const root = writeUserData(path.join(tempDir(), "Code - Insiders"), { associations: { [vscodeFolderUri(vault)]: association } });
    return { root, profile: profileOf(root), userData: path.join(tempDir(), "data") };
  };
  const readSettings = (userData: string) => JSON.parse(fs.readFileSync(path.join(userData, "User", "settings.json"), "utf8")) as Record<string, unknown>;

  it("the profile's own settings and keybindings are copied, not the instance root's", () => {
    const { profile, userData } = fixture(PROFILES.custom.location);
    expect(profile.name).toBe("FDE Practice");
    const src = profileSeedSource({ status: "resolved", profile }, null);
    const r = seedUserData({ userDataDir: userData, ...src });
    expect(r.settings).toBe("copied");
    expect(readSettings(userData)["editor.fontSize"]).toBe(22);
    expect(readSettings(userData).fixture).toMatch(/FDE Practice/);
    expect(Object.keys(readSettings(userData)).some((k) => k.startsWith("security.workspace.trust."))).toBe(false);
    const kb = Buffer.from(r.keybindingsBase64 as string, "base64").toString("utf8");
    expect(kb).toContain(TOGGLE_PANEL_KEY.command);
    expect(kb).not.toContain(TOGGLE_SIDEBAR_KEY.command);
  });

  it("Default reads the instance's User/ folder", () => {
    const { profile, userData } = fixture("__default__profile__");
    const r = seedUserData({ userDataDir: userData, ...profileSeedSource({ status: "resolved", profile }, null) });
    expect(readSettings(userData)["editor.fontSize"]).toBe(14);
    expect(Buffer.from(r.keybindingsBase64 as string, "base64").toString("utf8")).toContain(TOGGLE_SIDEBAR_KEY.command);
  });

  it("a second seed after the association moved replaces every FDE Practice value with Default's", () => {
    const root = writeUserData(path.join(tempDir(), "Code - Insiders"), { associations: { [vscodeFolderUri(vault)]: PROFILES.custom.location } });
    const userData = path.join(tempDir(), "data");
    const seed = () => seedUserData({ userDataDir: userData, ...profileSeedSource({ status: "resolved", profile: findMirroredProfile({ userDataRoot: root, vaultPath: vault }) }, null) });
    expect(seed().merged["editor.fontSize"]).toBe(22);
    const storage = path.join(root, "User", "globalStorage", "storage.json");
    const json = JSON.parse(fs.readFileSync(storage, "utf8"));
    json.profileAssociations.workspaces[vscodeFolderUri(vault)] = "__default__profile__";
    fs.writeFileSync(storage, JSON.stringify(json));
    const r = seed();
    expect(r.merged["editor.fontSize"]).toBe(14);
    expect(fs.readFileSync(path.join(userData, "User", "settings.json"), "utf8")).not.toContain("FDE Practice");
    expect(Buffer.from(r.keybindingsBase64 as string, "base64").toString("utf8")).not.toContain(TOGGLE_PANEL_KEY.command);
  });

  it("a profile with no keybindings.json removes a copy left from an earlier start", () => {
    const { root, profile, userData } = fixture(PROFILES.custom.location);
    const src = profileSeedSource({ status: "resolved", profile }, null);
    expect(seedUserData({ userDataDir: userData, ...src }).keybindings).toBe(true);
    fs.rmSync(path.join(root, "User", "profiles", PROFILES.custom.location, "keybindings.json"));
    const r = seedUserData({ userDataDir: userData, ...src });
    expect(r).toMatchObject({ keybindings: false, keybindingsBase64: null });
    expect(fs.existsSync(path.join(userData, "User", "keybindings.json"))).toBe(false);
  });

  it("a profile folder that is missing, or whose settings.json is missing or empty: excludes only, no keybindings, no throw", () => {
    const userData = path.join(tempDir(), "data");
    const missing = path.join(tempDir(), "gone");
    expect(seedUserData({ userDataDir: userData, sourceUserDir: missing })).toMatchObject({ settings: "missing", keybindings: false });
    const folder = tempDir();
    expect(seedUserData({ userDataDir: userData, sourceUserDir: folder })).toMatchObject({ settings: "missing", keybindings: false });
    fs.writeFileSync(path.join(folder, "settings.json"), "");
    const r = seedUserData({ userDataDir: userData, sourceUserDir: folder });
    expect(r).toMatchObject({ settings: "empty", keybindings: false });
    expect(Object.keys(readSettings(userData)).sort()).toEqual(EXCLUDE_KEYS);
  });

  it("an invalid profile settings.json: excludes only and the notice, which quotes nothing from the file", () => {
    const folder = tempDir();
    fs.writeFileSync(path.join(folder, "settings.json"), '{"github.token": "s3cret", "security.workspace.trust.enabled": false oops}');
    const userData = path.join(tempDir(), "data");
    const r = seedUserData({ userDataDir: userData, sourceUserDir: folder });
    expect(r.settings).toBe("invalid");
    expect(r.notice).not.toMatch(/s3cret|trust/);
    expect(Object.keys(readSettings(userData)).sort()).toEqual(EXCLUDE_KEYS);
  });

  it("a symlinked profile folder and a symlinked file are read by content; the copy is a regular file", () => {
    const real = tempDir();
    fs.writeFileSync(path.join(real, "settings.json"), '{"from.link": 1, "security.workspace.trust.enabled": false}');
    fs.writeFileSync(path.join(real, "keybindings.json"), "[7]");
    const link = path.join(tempDir(), "profile-link");
    fs.symlinkSync(real, link);
    const userData = path.join(tempDir(), "data");
    const r = seedUserData({ userDataDir: userData, sourceUserDir: link });
    expect(readSettings(userData)["from.link"]).toBe(1);
    expect(readSettings(userData)).not.toHaveProperty("security.workspace.trust.enabled");
    for (const f of [r.settingsFile, r.keybindingsFile]) expect(fs.lstatSync(f).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(r.keybindingsFile, "utf8")).toBe("[7]");
  });

  it("a useDefaultFlags profile copies Default's files, by the profile resolution (not a second implementation)", () => {
    const { root, profile, userData } = fixture(PROFILES.agents.location);
    expect(profile.name).toBe("Agents");
    const src = profileSeedSource({ status: "resolved", profile }, null);
    expect(src).toEqual({ sourceUserDir: path.join(root, "User"), keybindingsSourceDir: path.join(root, "User") });
    const r = seedUserData({ userDataDir: userData, ...src });
    expect(r.merged["editor.fontSize"]).toBe(14);
    expect(Buffer.from(r.keybindingsBase64 as string, "base64").toString("utf8")).toContain(TOGGLE_SIDEBAR_KEY.command);
  });

  it("a profile that takes only one kind from Default reads settings and keybindings from different folders", () => {
    const own = tempDir();
    const dflt = tempDir();
    fs.writeFileSync(path.join(own, "settings.json"), '{"editor.fontSize": 22}');
    fs.writeFileSync(path.join(own, "keybindings.json"), "[own]");
    fs.writeFileSync(path.join(dflt, "settings.json"), '{"editor.fontSize": 14}');
    fs.writeFileSync(path.join(dflt, "keybindings.json"), "[default]");
    const userData = path.join(tempDir(), "data");
    const r = seedUserData({ userDataDir: userData, sourceUserDir: own, keybindingsSourceDir: dflt });
    expect(r.merged["editor.fontSize"]).toBe(22);
    expect(fs.readFileSync(r.keybindingsFile, "utf8")).toBe("[default]");
  });

  it("profileSeedSource falls back to the given folder when the profile is not resolved", () => {
    for (const state of [{ status: "not-read" }, { status: "unavailable", reason: "x" }] as const) {
      expect(profileSeedSource(state, "/a/User")).toEqual({ sourceUserDir: "/a/User", keybindingsSourceDir: "/a/User" });
    }
    expect(profileSeedSource({ status: "not-read" }, null)).toEqual({ sourceUserDir: null, keybindingsSourceDir: null });
  });

  it("the destination guards hold with the profile folder as the source (settings and keybindings sides)", () => {
    const userData = tempDir();
    const profileInside = path.join(userData, "User", "profiles", "p1");
    expect(() => seedUserData({ userDataDir: userData, sourceUserDir: profileInside })).toThrow(/destination is inside the instance|inside the plugin/);
    expect(() => seedUserData({ userDataDir: userData, sourceUserDir: tempDir(), keybindingsSourceDir: profileInside })).toThrow(/inside the plugin|destination is inside/);
    const profile = tempDir();
    const inner = path.join(profile, "inner-data");
    expect(() => seedUserData({ userDataDir: inner, sourceUserDir: profile })).toThrow();
    expect(fs.existsSync(inner)).toBe(false);
    expect(() => seedUserData({ userDataDir: path.join(profile, "x"), sourceUserDir: tempDir(), keybindingsSourceDir: profile })).toThrow();
  });

  it("nothing is written in the profile folder or anywhere beside the user-data dir", () => {
    const { root, profile, userData } = fixture(PROFILES.custom.location);
    const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
    const before = files(root).map((f) => [f, fs.readFileSync(f, "utf8")]);
    seedUserData({ userDataDir: userData, ...profileSeedSource({ status: "resolved", profile }, null) });
    expect(files(root).map((f) => [f, fs.readFileSync(f, "utf8")])).toEqual(before);
    expect(fs.readdirSync(userData)).toEqual(["User"]);
    expect(fs.readdirSync(path.join(userData, "User")).sort()).toEqual(["keybindings.json", "settings.json"]);
  });
});
