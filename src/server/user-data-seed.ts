/**
 * At each server start (G16, G17): copy the chosen instance's `User/settings.json`
 * and `User/keybindings.json` one way into the plugin-owned user-data dir, and
 * write the workspace excludes on top of the settings.
 *
 * Rules (F3): the source files are only read (opened read-only, never touched);
 * every write goes to a temp name inside the destination folder and is renamed
 * into place, so two starts in quick succession never leave a half-written
 * file; the destination is always inside the plugin's user-data dir. Nothing is
 * created in the vault by this module except under that dir.
 *
 * Where these files take effect: serve-web's workbench does NOT read `User/settings.json` or
 * `User/keybindings.json` from the server's data dir (measured, docs/spike-decision.md): user settings
 * and keybindings are read from the Code tab's browser profile. The caller therefore also gives
 * `SeedResult.merged` and `.keybindingsBase64` to the browser seed (`buildBrowserSeedScript`), and the
 * excludes are also written to the server's Machine settings (`buildMachineSettings`), which the
 * server does read.
 *
 * The copied settings may hold the user's secrets (tokens in extension
 * settings): the files are created mode 0600 in a mode-0700 folder, and no
 * message produced here quotes their content.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Folders kept out of watching and search in the vault workspace (G16). */
export const WORKSPACE_EXCLUDE_FOLDERS = [".git", ".obsidian", "Attachments", "node_modules", "_to_delete"] as const;

/** Settings that carry the excludes. */
export const EXCLUDE_SETTING_KEYS = ["files.watcherExclude", "search.exclude"] as const;

export function excludeGlobs(): Record<string, true> {
  return Object.fromEntries(WORKSPACE_EXCLUDE_FOLDERS.map((f) => [`**/${f}`, true as const]));
}

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

export class JsoncError extends Error {
  constructor(readonly offset: number) {
    super(`not valid JSON (near character ${offset})`);
    this.name = "JsoncError";
  }
}

/** Remove `//` and block comments and trailing commas, leaving strings alone. Throws JsoncError on an unterminated string or comment. */
export function stripJsonc(text: string): string {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) throw new JsoncError(i);
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end < 0) throw new JsoncError(i);
      i = end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: a comma followed (after whitespace) by } or ], outside strings.
  let result = "";
  let k = 0;
  while (k < out.length) {
    const c = out[k];
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      result += out.slice(k, j + 1);
      k = j + 1;
    } else if (c === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") {
        k++; // drop the comma
      } else {
        result += c;
        k++;
      }
    } else {
      result += c;
      k++;
    }
  }
  return result;
}

/** Parse JSON with comments and trailing commas. Throws JsoncError; the message never quotes the text. */
export function parseJsonc(text: string): unknown {
  const stripped = stripJsonc(text);
  try {
    return JSON.parse(stripped);
  } catch {
    throw new JsoncError(0);
  }
}

// ---------------------------------------------------------------------------
// The merged settings
// ---------------------------------------------------------------------------

export type SettingsSource = "copied" | "missing" | "empty" | "invalid";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The settings to write: the source's keys (when it parsed) with the excludes
 * merged on top. The user's own exclude patterns stay; ours are set to true and
 * win over a copied value for the same pattern.
 */
export function buildSettings(sourceText: string | null): { settings: Record<string, unknown>; source: SettingsSource } {
  let base: Record<string, unknown> = {};
  let source: SettingsSource = "missing";
  if (sourceText !== null) {
    if (sourceText.trim() === "") {
      source = "empty";
    } else {
      try {
        const parsed = parseJsonc(sourceText);
        if (isPlainObject(parsed)) {
          base = parsed;
          source = "copied";
        } else {
          source = "invalid";
        }
      } catch {
        source = "invalid";
      }
    }
  }
  const globs = excludeGlobs();
  const merged: Record<string, unknown> = { ...base };
  for (const key of EXCLUDE_SETTING_KEYS) {
    merged[key] = { ...(isPlainObject(base[key]) ? (base[key] as Record<string, unknown>) : {}), ...globs };
  }
  return { settings: merged, source };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Write `data` to `dest` through a temp file in the same folder and a rename. */
export function writeAtomic(dest: string, data: string | Buffer): void {
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `.${path.basename(dest)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, dest);
  } catch (e) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** The file's bytes, or null when it does not exist. Opened read-only; a symlink is followed, so the content is read. */
function readSource(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return null;
    throw e;
  }
}

export interface SeedResult {
  /** What became of the source settings.json. */
  settings: SettingsSource;
  /** keybindings.json was copied (false: missing in the source, or no source). */
  keybindings: boolean;
  /**
   * What was written to `User/settings.json`: the copied keys with the excludes on top. The Code tab
   * hands this to the browser profile (src/settings.ts), because that is where the workbench reads user
   * settings; the file itself is the plugin-owned copy.
   */
  merged: Record<string, unknown>;
  /** The copied keybindings.json, base64 (byte-exact), or null when there is none. Same destination as `merged`. */
  keybindingsBase64: string | null;
  settingsFile: string;
  keybindingsFile: string;
  /** Set when the source settings.json could not be used: shown to Dan as a notice. */
  notice: string | null;
}

export interface SeedOptions {
  /** The plugin-owned user-data dir; `User/` is created in it. */
  userDataDir: string;
  /** The chosen instance's `User/` folder, or null when it cannot be told. */
  sourceUserDir: string | null;
}

export function seedUserData(o: SeedOptions): SeedResult {
  const userDir = path.join(o.userDataDir, "User");
  const settingsFile = path.join(userDir, "settings.json");
  const keybindingsFile = path.join(userDir, "keybindings.json");
  for (const dest of [settingsFile, keybindingsFile]) {
    if (!isInside(dest, o.userDataDir)) throw new Error("The user-data destination is outside the plugin's user-data dir.");
    if (o.sourceUserDir && isInside(dest, o.sourceUserDir)) throw new Error("The user-data destination is inside the instance's own folder.");
  }
  if (o.sourceUserDir && isInside(o.sourceUserDir, o.userDataDir)) throw new Error("The instance's user folder is inside the plugin's user-data dir.");
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });

  const src = o.sourceUserDir;
  let settingsRaw: Buffer | null = null;
  let keybindingsRaw: Buffer | null = null;
  let readError = false;
  if (src) {
    try {
      settingsRaw = readSource(path.join(src, "settings.json"));
    } catch {
      readError = true;
    }
    try {
      keybindingsRaw = readSource(path.join(src, "keybindings.json"));
    } catch {
      /* unreadable keybindings: skipped */
    }
  }

  const built = readError ? { ...buildSettings(null), source: "invalid" as SettingsSource } : buildSettings(settingsRaw === null ? null : settingsRaw.toString("utf8"));
  writeAtomic(settingsFile, JSON.stringify(built.settings, null, 2));

  if (keybindingsRaw !== null) writeAtomic(keybindingsFile, keybindingsRaw);
  else fs.rmSync(keybindingsFile, { force: true }); // a copy from an earlier start must not outlive its source

  return {
    settings: built.source,
    keybindings: keybindingsRaw !== null,
    merged: built.settings,
    keybindingsBase64: keybindingsRaw !== null ? keybindingsRaw.toString("base64") : null,
    settingsFile,
    keybindingsFile,
    notice:
      built.source === "invalid"
        ? "The instance's settings.json could not be read, so only the workspace excludes were applied. Fix the file in that VS Code and restart the server."
        : null,
  };
}

/** The instance's `User/` folder under Application Support, or null when its folder name is unknown or unsafe. */
export function instanceUserDir(userDataName: string | null, appSupport: string): string | null {
  if (!userDataName || userDataName === "." || userDataName === ".." || /[\\/\0]/.test(userDataName)) return null;
  return path.join(appSupport, userDataName, "User");
}
