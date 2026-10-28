import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "../helpers";

/**
 * The fences of the extension spike (ticket warkworth-36, PR-1), checked on the source and on the measuring
 * script itself: no file watchers (F7), no profile settings mirror (F8), and the desktop instance is only ever
 * read (F1). Also the script's plain-message exits, run for real.
 */

const root = path.resolve(__dirname, "../..");
const SCRIPT = path.join(root, "tests/render/extension-spike.mjs");
const FIXTURE_SCRIPT = path.join(root, "tests/fixtures/make-fake-instances.sh");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sourceFiles(p) : /\.(ts|mjs|js)$/.test(e.name) ? [p] : [];
  });
}
const SRC = sourceFiles(path.join(root, "src"));
const rel = (f: string) => path.relative(root, f);
const grep = (re: RegExp) => SRC.filter((f) => re.test(fs.readFileSync(f, "utf8"))).map(rel);

describe("F7: no file watchers on the instance's folders; the spike reads state once, on demand", () => {
  it("src/ has no fs.watch, watchFile, watch(...) from fs, or chokidar", () => {
    expect(grep(/\bfs\.watch\b|\bwatchFile\b|\bunwatchFile\b|chokidar|from "node:fs"[^\n]*\bwatch\b|\bfs\.promises\.watch\b/)).toEqual([]);
  });

  it("the Extensions section starts no timer and has no import of fs: it draws what it is given", () => {
    const text = fs.readFileSync(path.join(root, "src/settings/extensions-section.ts"), "utf8");
    expect(text).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|registerInterval/);
    expect(text).not.toMatch(/from "node:fs"|from "fs"/);
    const tab = fs.readFileSync(path.join(root, "src/settings/settings-tab.ts"), "utf8");
    expect(tab).not.toMatch(/setInterval/);
  });

  it("the spike script starts no watcher either", () => {
    expect(fs.readFileSync(SCRIPT, "utf8").replace(/^\s*(\*|\/\/).*$/gm, "")).not.toMatch(/\bfs\.watch\b|watchFile|chokidar/);
  });
});

describe("F8: nothing in src/ builds or wires the profile settings mirror", () => {
  it("only the read-only profile finder (PR-3) mentions user data profiles", () => {
    expect(grep(/userDataProfiles|profileAssociations|__default__profile__|User\/profiles|"profiles"/)).toEqual(["src/profile/mirrored-profile.ts"]);
  });

  it("the profile finder has no way to write: no write, create, rename, delete or watch call, and no child process", () => {
    const code = fs.readFileSync(path.join(root, "src/profile/mirrored-profile.ts"), "utf8").replace(/^\s*(\*|\/\/|\/\*).*$/gm, "");
    expect(code).not.toMatch(/writeFile|appendFile|mkdir|rmSync|rmdir|unlink|rename|copyFile|cpSync|chmod|chown|utimes|symlink|truncate|createWriteStream|\bopenSync\b|\bwatch|child_process|sqlite/);
    expect(code).toMatch(/readFileSync/);
  });

  it("the only files in src/ that use a settings.json path literal are the ones that already did before the spike", () => {
    // The copy of the chosen instance's Default settings (G16/G17), the Machine file and the IndexedDB key. A new
    // reader of a profile's settings.json would show up here; add a file to this list only on purpose.
    // src/profile/mirrored-profile.ts (PR-3) is listed because its doc comment names the file; it never opens one.
    expect(grep(/["'`](\/User\/)?settings\.json["'`]/).sort()).toEqual(["src/profile/mirrored-profile.ts", "src/server/user-data-seed.ts", "src/settings.ts", "src/workbench-db.ts"].sort());
  });
});

describe("F1: the measuring script only reads the desktop instance", () => {
  const text = fs.readFileSync(SCRIPT, "utf8");
  const code = text.replace(/^\s*(\*|\/\/).*$/gm, "");
  const INSTANCE_PATHS = /\b(INSTANCE|EXT_DIR|APP_SUPPORT|VAULT_FOLDER)\b|Application Support|\.vscode-insiders/;

  it("no write call has the instance, its extensions folder or the vault as its destination", () => {
    const writes = [...code.matchAll(/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|rmdirSync|mkdirSync|chmodSync|truncateSync|symlinkSync|cpSync|copyFileSync|renameSync|writeFile|rm|unlink)\(([^;]*)/g)];
    expect(writes.length).toBeGreaterThan(5); // the pattern finds the script's own scratch writes
    for (const w of writes) {
      const args = w[2].split(",").map((a) => a.trim());
      // copyFileSync / cpSync / symlinkSync / renameSync: the source is read; the destination is the second argument
      const dests = ["copyFileSync", "cpSync"].includes(w[1]) ? [args[1] ?? ""] : w[1] === "renameSync" ? [args[0], args[1] ?? ""] : [args[0]];
      for (const d of dests) expect(`${w[1]}(${d}`, `${w[0].slice(0, 100)}`).not.toMatch(INSTANCE_PATHS);
    }
  });

  it("a state.vscdb is read only from a temp copy, with sqlite3 -readonly", () => {
    expect(code).toMatch(/fs\.copyFileSync\(db, copy\)/);
    expect(code).toMatch(/execFileSync\(SQLITE, \["-readonly", copy,/);
    const sqliteCalls = [...code.matchAll(/execFileSync\(SQLITE\b/g)];
    expect(sqliteCalls).toHaveLength(1);
  });

  it("it never starts an installer or touches an extension (no `--install-extension`, `--uninstall`, `--enable`, `--disable`)", () => {
    expect(code).not.toMatch(/--install-extension|--uninstall-extension|--enable-extension|--disable-extension/);
  });

  it("it stops only what it started, by PID, and never by name", () => {
    expect(code).not.toMatch(/pkill|killall|lsof/);
    expect(code).toMatch(/started\.push\(server\.pid\)/);
    expect(code).toMatch(/started\.push\(chrome\.pid\)/);
  });

  it("every server and browser it starts is on a port it picked free, never a fixed one", () => {
    expect(code).not.toMatch(/--port",?\s*"\d+"|remote-debugging-port=\d+/);
    expect(code).toMatch(/freePort\(\)/);
  });

  it("is wired as `npm run check:extensions-spike` and is not part of `npm test`", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:extensions-spike"]).toBe("node tests/render/extension-spike.mjs");
    expect(pkg.scripts.test).not.toContain("extension-spike");
    expect(fs.readFileSync(path.join(root, "vitest.config.mts"), "utf8")).not.toContain("tests/render");
  });
});

/** Run the spike script with a clean environment; it must exit before starting any server or browser. */
function runScript(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SCRIPT, tempDir()], {
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TMPDIR: tempDir(), ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const sqlite = ["/usr/bin/sqlite3", ...(process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "sqlite3"))].find((f) => fs.existsSync(f));

describe("the measuring script exits with a plain message, not a stack trace", () => {
  const plain = (out: string) => {
    expect(out).not.toMatch(/\n\s+at .*\(.*:\d+:\d+\)/);
    expect(out).not.toContain("node:internal");
  };

  it("sqlite3 cannot be found", () => {
    const r = runScript({ SQLITE3: "/nonexistent/sqlite3" });
    expect(r.status).toBe(2);
    expect(r.out).toContain("sqlite3 was not found");
    plain(r.out);
  });

  it("the Insiders instance folder is missing", () => {
    const r = runScript({ SQLITE3: sqlite ?? process.execPath, CODE_CLI: process.execPath, CHROME: process.execPath, APP_SUPPORT: path.join(tempDir(), "no-such-folder") });
    expect(r.status).toBe(2);
    expect(r.out).toContain("the VS Code instance folder");
    expect(r.out).toContain("does not exist");
    plain(r.out);
  });

  it("Chrome or VS Code is missing", () => {
    const r = runScript({ SQLITE3: sqlite ?? process.execPath, CODE_CLI: process.execPath, CHROME: "/nonexistent/chrome" });
    expect(r.status).toBe(2);
    expect(r.out).toContain("needs CHROME");
    plain(r.out);
  });
});

describe("GP1: the script asserts the fixture from the instance's own files before it starts anything", () => {
  /** A fake instance made by tests/fixtures/make-fake-instances.sh, and the env that points the script at it. */
  function fixture() {
    const base = tempDir();
    const tree = path.join(base, "fake");
    execFileSync(FIXTURE_SCRIPT, [tree]);
    const support = path.join(tree, "AppSupport");
    const ext = path.join(tree, "Home/.vscode-insiders/extensions");
    const vault = path.join(tree, "Vault");
    const storage = path.join(support, "Code - Insiders/User/globalStorage/storage.json");
    const env = { SQLITE3: sqlite ?? process.execPath, CODE_CLI: process.execPath, CHROME: process.execPath, APP_SUPPORT: support, EXTENSIONS_DIR: ext, VAULT_FOLDER: vault };
    return { tree, support, ext, vault, storage, env };
  }
  const checksums = (dir: string) => {
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
  };

  it("the fake Insiders folder lists Turbo Console Log and associates the vault with the Default profile", () => {
    const f = fixture();
    const ids = (JSON.parse(fs.readFileSync(path.join(f.ext, "extensions.json"), "utf8")) as Array<{ identifier: { id: string } }>).map((e) => e.identifier.id);
    expect(ids).toEqual(["chakrounanas.turbo-console-log"]);
    const storage = JSON.parse(fs.readFileSync(f.storage, "utf8")) as { profileAssociations: { workspaces: Record<string, string> } };
    expect(storage.profileAssociations.workspaces[pathToFileURL(f.vault).href]).toBe("__default__profile__");
  });

  it("a matching fixture passes GP1 (the script goes on to the next check, which stops it here as there is no VS Code server)", () => {
    const f = fixture();
    const before = checksums(f.tree);
    const r = runScript(f.env);
    expect(r.out).toContain("GP1 fixture, from the instance's own files:");
    expect(r.out).toContain("chakrounanas.turbo-console-log 3.29.0");
    expect(r.out).toContain("= __default__profile__");
    expect(r.out).not.toContain("GP1 fixture does not match");
    expect(r.status).toBe(2);
    expect(r.out).toContain("extension spike cannot run: the VS Code");
    expect(checksums(f.tree)).toEqual(before); // the script wrote nothing into the fixture
  });

  it("Turbo Console Log missing from extensions.json: exits 2 with the reason, before anything starts", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.ext, "extensions.json"), "[]");
    const r = runScript(f.env);
    expect(r.status).toBe(2);
    expect(r.out).toContain("GP1 fixture does not match: Turbo Console Log");
    expect(r.out).toContain("is not listed");
  });

  it("the vault associated with another profile: exits 2 with what it found", () => {
    const f = fixture();
    const storage = JSON.parse(fs.readFileSync(f.storage, "utf8")) as { profileAssociations: { workspaces: Record<string, string> } };
    storage.profileAssociations.workspaces[pathToFileURL(f.vault).href] = "-257b33c0";
    fs.writeFileSync(f.storage, JSON.stringify(storage));
    const r = runScript(f.env);
    expect(r.status).toBe(2);
    expect(r.out).toContain("is not associated with the Default profile");
    expect(r.out).toContain("found: -257b33c0");
  });

  it("the vault with no association at all: exits 2 and says there is none", () => {
    const f = fixture();
    fs.writeFileSync(f.storage, JSON.stringify({ profileAssociations: { workspaces: {} } }));
    const r = runScript(f.env);
    expect(r.status).toBe(2);
    expect(r.out).toContain("found: no association");
  });

  it.runIf(Boolean(sqlite))("Turbo Console Log disabled in the instance's state.vscdb (read from a temp copy): exits 2, and the original is untouched", () => {
    const f = fixture();
    const db = path.join(f.support, "Code - Insiders/User/globalStorage/state.vscdb");
    execFileSync(sqlite!, [db, `CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); INSERT INTO ItemTable VALUES ('extensionsIdentifiers/disabled', '[{"id":"chakrounanas.turbo-console-log"}]');`]);
    const before = checksums(f.tree);
    const r = runScript(f.env);
    expect(r.status).toBe(2);
    expect(r.out).toContain("GP1 fixture does not match: Turbo Console Log is disabled in the instance");
    expect(checksums(f.tree)).toEqual(before); // sqlite3 opened a copy, not the instance's file
  });
});
