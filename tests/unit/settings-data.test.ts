import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCliPath } from "../../src/instances/probe";
import {
  DEFAULT_SETTINGS,
  addExtension,
  dataObject,
  defaultShell,
  effectiveShell,
  normaliseExtension,
  normaliseExtensionList,
  readSettings,
} from "../../src/settings/data";
import { EXIT1_SCRIPT, HANG_SCRIPT, NO_MENTION_SCRIPT, PASS_SCRIPT, SILENT_SCRIPT } from "../instance-helpers";
import { tempDir } from "../helpers";

describe("defaults", () => {
  it("an empty or missing data.json gives every default", () => {
    expect(readSettings({})).toEqual({
      instanceId: null,
      customCliPath: null,
      excludeExtensions: [],
      nonCodeDrawer: true,
      shellPath: "",
      stablePort: null,
    });
    expect(readSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("the non-code drawer toggle is on by default", () => {
    expect(readSettings({}).nonCodeDrawer).toBe(true);
  });

  it("the shell defaults to $SHELL, else /bin/zsh", () => {
    expect(defaultShell({ SHELL: "/opt/homebrew/bin/fish" })).toBe("/opt/homebrew/bin/fish");
    expect(defaultShell({})).toBe("/bin/zsh");
    expect(defaultShell({ SHELL: "" })).toBe("/bin/zsh");
    expect(defaultShell({ SHELL: "zsh" })).toBe("/bin/zsh"); // not an absolute path
    expect(effectiveShell({ shellPath: "" }, { SHELL: "/bin/bash" })).toBe("/bin/bash");
    expect(effectiveShell({ shellPath: "  /usr/bin/fish " }, { SHELL: "/bin/bash" })).toBe("/usr/bin/fish");
  });
});

describe("the stored stable port", () => {
  it.each([
    ["missing", undefined, null],
    ["null", null, null],
    ["a string", "8080", null],
    ["a boolean", true, null],
    ["an array", [8080], null],
    ["a fraction", 8080.5, null],
    ["NaN", Number.NaN, null],
    ["negative", -1, null],
    ["zero", 0, null],
    ["below 1024", 1023, null],
    ["above 65535", 65536, null],
    ["far above 65535", 1e9, null],
    ["Infinity", Infinity, null],
    ["the lowest valid port", 1024, 1024],
    ["an ordinary port", 51789, 51789],
    ["the highest valid port", 65535, 65535],
  ])("%s reads as %s", (_name, stored, expected) => {
    expect(readSettings({ stablePort: stored }).stablePort).toBe(expected);
  });

  it("an invalid stored port does not disturb the other fields", () => {
    expect(readSettings({ stablePort: 99999, nonCodeDrawer: false, shellPath: "/bin/bash" })).toEqual({ ...DEFAULT_SETTINGS, nonCodeDrawer: false, shellPath: "/bin/bash" });
  });

  it("round-trips through the data object the plugin saves (the field name is stablePort)", () => {
    const saved = { ...dataObject({ other: 1 }), stablePort: 51789 };
    expect(readSettings(JSON.parse(JSON.stringify(saved))).stablePort).toBe(51789);
  });
});

describe("a corrupt, partial or odd data.json falls back field by field", () => {
  it.each([
    ["a string", "not an object"],
    ["a number", 42],
    ["an array", [1, 2]],
    ["null", null],
  ])("%s as the whole file gives all defaults", (_n, raw) => {
    expect(readSettings(raw)).toEqual(DEFAULT_SETTINGS);
    expect(dataObject(raw)).toEqual({});
  });

  it("keeps the good fields and defaults the bad ones", () => {
    const s = readSettings({
      instanceId: 7,
      customCliPath: "/usr/local/bin/code",
      excludeExtensions: "py",
      nonCodeDrawer: "yes",
      shellPath: ["/bin/zsh"],
    });
    expect(s).toEqual({ instanceId: null, customCliPath: "/usr/local/bin/code", excludeExtensions: [], nonCodeDrawer: true, shellPath: "", stablePort: null });
  });

  it("keeps a false toggle and a saved instance id exactly as stored", () => {
    const s = readSettings({ nonCodeDrawer: false, instanceId: "vscode:/Applications/Gone.app" });
    expect(s.nonCodeDrawer).toBe(false);
    expect(s.instanceId).toBe("vscode:/Applications/Gone.app"); // a stale id is not dropped here
  });

  it("treats an empty-string path or id as unset", () => {
    expect(readSettings({ instanceId: "  ", customCliPath: "" })).toMatchObject({ instanceId: null, customCliPath: null });
  });

  it("cleans a stored exclude list: bad entries and duplicates dropped, the rest normalised", () => {
    expect(readSettings({ excludeExtensions: [".PY", "py", 3, null, "a b", "x/y", "", " Md ", "d.ts"] }).excludeExtensions).toEqual(["py", "md", "d.ts"]);
  });

  it("dataObject copies a plain object and leaves unknown fields alone", () => {
    const raw = { serverLicenceAccepted: true, extra: { a: 1 } };
    const copy = dataObject(raw);
    expect(copy).toEqual(raw);
    expect(copy).not.toBe(raw);
  });
});

describe("exclude-list normalisation (G15)", () => {
  it.each([
    [".PY", "py"],
    ["py", "py"],
    ["  Py  ", "py"],
    [".Py", "py"],
    ["TXT", "txt"],
    [".d.ts", "d.ts"],
    ["tar.gz", "tar.gz"],
  ])("%j becomes %j", (input, value) => {
    expect(normaliseExtension(input)).toEqual({ ok: true, value });
  });

  it.each([
    ["", /Enter a file extension/],
    ["   ", /Enter a file extension/],
    [".", /Enter a file extension/],
    ["a b", /space/],
    ["a\tb", /space/],
    [".py ext", /space/],
    ["a/b", /slash/],
    ["/py", /slash/],
    [".a/b", /slash/],
  ])("rejects %j with a message", (input, reason) => {
    const r = normaliseExtension(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("adds .PY then py as one entry (de-duplicated), keeping the order", () => {
    let list: string[] = [];
    const a = addExtension(list, ".PY");
    expect(a).toEqual({ ok: true, list: ["py"], added: true });
    list = a.ok ? a.list : [];
    const b = addExtension(list, "py");
    expect(b).toEqual({ ok: true, list: ["py"], added: false });
    const c = addExtension(list, "md");
    expect(c).toEqual({ ok: true, list: ["py", "md"], added: true });
  });

  it("a rejected entry leaves the list as it was", () => {
    const list = ["py"];
    expect(addExtension(list, "a b").ok).toBe(false);
    expect(list).toEqual(["py"]);
  });

  it("normaliseExtensionList tolerates non-arrays", () => {
    expect(normaliseExtensionList(undefined)).toEqual([]);
    expect(normaliseExtensionList({ 0: "py" })).toEqual([]);
  });
});

describe("custom CLI path validation (G15)", () => {
  function script(content: string, name = "code", dir = tempDir()): string {
    const f = path.join(dir, name);
    fs.writeFileSync(f, content, { mode: 0o755 });
    return f;
  }

  it("accepts an absolute path to an executable that passes the probe", async () => {
    const cli = script(PASS_SCRIPT);
    expect(await verifyCliPath(cli)).toEqual({ ok: true, cli });
  });

  it("trims the typed path", async () => {
    const cli = script(PASS_SCRIPT);
    expect(await verifyCliPath(`  ${cli}\n`)).toEqual({ ok: true, cli });
  });

  it.each([
    ["nothing typed", "", /Enter the path/],
    ["a relative path", "bin/code", /absolute path/],
    ["a bare command name", "code", /absolute path/],
    ["a tilde path", "~/bin/code", /absolute path/],
  ])("rejects %s", async (_n, input, reason) => {
    const r = await verifyCliPath(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("rejects a missing file", async () => {
    const r = await verifyCliPath(path.join(tempDir(), "gone"));
    expect(r).toEqual({ ok: false, reason: "No file exists at that path." });
  });

  it("rejects a directory", async () => {
    const r = await verifyCliPath(tempDir());
    expect(r).toEqual({ ok: false, reason: "That path is a folder; enter the command-line tool inside it." });
  });

  it("rejects a file that is not executable", async () => {
    const f = path.join(tempDir(), "code");
    fs.writeFileSync(f, PASS_SCRIPT, { mode: 0o644 });
    expect(await verifyCliPath(f)).toEqual({ ok: false, reason: "That file is not executable." });
  });

  it.each([
    ["exits 1", EXIT1_SCRIPT, /exited with code 1/],
    ["prints nothing", SILENT_SCRIPT, /no "serve-web" command/],
    ["does not mention serve-web", NO_MENTION_SCRIPT, /no "serve-web" command/],
  ])("rejects a program that %s, with the reason", async (_n, content, reason) => {
    const r = await verifyCliPath(script(content));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("rejects a program that hangs, after the timeout, and kills it", async () => {
    const dir = tempDir();
    const pidfile = path.join(dir, "pid");
    process.env.HANG_PIDFILE = pidfile;
    try {
      const started = Date.now();
      const r = await verifyCliPath(script(HANG_SCRIPT, "hang", dir), { timeoutMs: 1500 });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/no answer within/);
      const pid = Number(fs.readFileSync(pidfile, "utf8"));
      await new Promise((res) => setTimeout(res, 100));
      expect(() => process.kill(pid, 0)).toThrow(); // gone
    } finally {
      delete process.env.HANG_PIDFILE;
    }
  });

  it("runs a path with spaces and shell characters without a shell", async () => {
    const parent = tempDir();
    const marker = `WB_INJECTED_${process.pid}`; // a shell would run `touch` in the cwd (or the parent) of the process
    const dir = path.join(parent, `a b; touch ${marker} $(touch ${marker}) \`touch ${marker}\``);
    fs.mkdirSync(dir);
    const cli = script(PASS_SCRIPT, "co de; $( )", dir);
    expect(await verifyCliPath(cli)).toEqual({ ok: true, cli });
    for (const where of [process.cwd(), parent, dir]) expect(fs.existsSync(path.join(where, marker))).toBe(false);
  });
});
