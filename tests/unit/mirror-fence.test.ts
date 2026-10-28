/**
 * F1/F4: the mirror reads desktop VS Code's state without touching it, and the bundle gains no native module or SQL
 * library. Static checks over the source of src/mirror/ and over package.json.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { listTsFiles, REPO_ROOT } from "../helpers";

const MIRROR = path.join(REPO_ROOT, "src", "mirror");
const files = listTsFiles(MIRROR).map((f) => path.join(MIRROR, f));
const code = (file: string) => fs.readFileSync(file, "utf8").replace(/^\s*(\*|\/\/|\/\*).*$/gm, "");
const rel = (f: string) => path.relative(REPO_ROOT, f);

describe("F1: nothing in src/mirror/ opens desktop VS Code's files for writing", () => {
  it("the mirror module is these files, so a new one has to be added here on purpose", () => {
    expect(files.map(rel).sort()).toEqual(["src/mirror/disabled-lists.ts", "src/mirror/mirror-fs.ts", "src/mirror/mirror.ts", "src/mirror/snapshot.ts", "src/mirror/sqlite-read.ts"]);
  });

  it("only mirror-fs.ts touches node:fs; every other file goes through the MirrorFs interface", () => {
    for (const f of files) {
      const importsFs = /from\s+["']node:fs|require\(["'](node:)?fs/.test(code(f));
      expect(importsFs, rel(f)).toBe(path.basename(f) === "mirror-fs.ts");
    }
  });

  it("no synchronous file call anywhere in src/mirror/ (a 50 MB copy must not block the main thread)", () => {
    for (const f of files) expect(code(f), rel(f)).not.toMatch(/\b\w+Sync\s*\(/);
  });

  it("the readers (disabled-lists, sqlite-read) write only through copyFile/mkdtemp/rm on the plugin's temp copy: no writeFile, rename, chmod, utimes, symlink or truncate", () => {
    for (const name of ["disabled-lists.ts", "sqlite-read.ts"]) {
      expect(code(path.join(MIRROR, name)), name).not.toMatch(/\.(writeFile|appendFile|rename|chmod|chown|utimes|symlink|truncate|createWriteStream|openSync)\b|\bwatch\b/);
    }
  });

  it("the only writeFile/rename call (apart from the MirrorFs wrapper itself) is in snapshot.ts, and it writes inside the data dir it is given", () => {
    const users = files.filter((f) => path.basename(f) !== "mirror-fs.ts" && /\.(writeFile|rename)\(/.test(code(f))).map((f) => path.basename(f));
    expect(users).toEqual(["snapshot.ts"]);
    const text = code(path.join(MIRROR, "snapshot.ts"));
    expect(text).toMatch(/path\.join\(dataDir, SNAPSHOT_FILE\)/);
  });

  it("sqlite3 is only ever given the temp copy: -readonly first, and the path argument is the copy", () => {
    const text = code(path.join(MIRROR, "sqlite-read.ts"));
    expect(text).toMatch(/"-readonly"/);
    expect(text).toMatch(/\["-readonly", "-json", copy,/);
  });

  it("the original database is only ever an argument of copyFile, never of the runner", () => {
    const text = code(path.join(MIRROR, "sqlite-read.ts"));
    expect(text.match(/copyFile\(([^)]*)\)/g)?.every((c) => /dbPath|src|source/.test(c))).toBe(true);
    expect(text).not.toMatch(/run\(\s*\[[^\]]*dbPath/);
  });
});

describe("F4: no native module and no SQL library", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };

  it("package.json names no SQLite, SQL.js or native-addon package", () => {
    const bad = Object.keys(all).filter((n) => /sqlite|sql\.js|sql-wasm|better-sqlite|node-gyp|node-addon|bindings|prebuild|ffi|napi/i.test(n));
    expect(bad).toEqual([]);
  });

  it("nothing under src/ imports better-sqlite3, sqlite3, node:sqlite, sql.js or a .node addon", () => {
    const banned = /(?:from\s+|require\(\s*|import\(\s*)["'](?:better-sqlite3|sqlite3|node:sqlite|sqlite|sql\.js|@sqlite\.org\/[^"']*|[^"']*\.node)["']/;
    for (const f of listTsFiles(path.join(REPO_ROOT, "src")).map((n) => path.join(REPO_ROOT, "src", n))) {
      expect(fs.readFileSync(f, "utf8"), rel(f)).not.toMatch(banned);
    }
    // The pattern itself catches each of them.
    for (const spec of ["better-sqlite3", "sqlite3", "node:sqlite", "sql.js", "./build/addon.node"]) expect(`import x from "${spec}";`).toMatch(banned);
  });

  it("src/ imports nothing that is not a relative path, node:*, obsidian or a package.json dependency", () => {
    const declared = new Set(Object.keys(all));
    for (const f of listTsFiles(path.join(REPO_ROOT, "src")).map((n) => path.join(REPO_ROOT, "src", n))) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1];
        if (spec.startsWith(".") || spec.startsWith("node:") || spec === "obsidian" || spec === "electron") continue;
        expect(declared.has(spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/")), `${rel(f)} imports ${spec}`).toBe(true);
      }
    }
  });

  it("child processes are started only by execFile with an argument array, never through a shell, in src/mirror/", () => {
    for (const f of files) {
      const c = code(f);
      expect(c, rel(f)).not.toMatch(/\bexec\(|execSync|spawnSync|shell:\s*true|\bsh -c\b/);
    }
    expect(code(path.join(MIRROR, "sqlite-read.ts"))).toMatch(/execFile/);
  });

  it("only sqlite-read.ts starts a process", () => {
    expect(files.filter((f) => /child_process/.test(code(f))).map((f) => path.basename(f))).toEqual(["sqlite-read.ts"]);
  });
});
