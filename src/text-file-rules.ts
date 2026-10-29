/**
 * Which vault files may open in a Code tab (the Settled calls and fence F6):
 *
 *  - contents of `.obsidian`, `.git` and `node_modules` stay hidden;
 *  - dotfiles open (`.env`, `.gitignore`), as do `svg`, `csv`, `txt` and `json` (text);
 *  - markdown, canvas, base and binaries never open in a Code tab;
 *  - an extension on the user's exclude list never does.
 *
 * Pure: no Obsidian and no file system. Paths are vault-relative with `/` separators.
 */

/** Folders whose contents are never offered (G16 keeps them out of the workspace too). */
export const HIDDEN_FOLDERS: readonly string[] = [".obsidian", ".git", "node_modules"];

/** Obsidian's own formats: never opened in a Code tab (F6). */
export const NEVER_CODE_EXTENSIONS: readonly string[] = ["md", "canvas", "base"];

/**
 * Binary formats (F6): Obsidian's own viewers handle some of them (images, audio, video, pdf);
 * the rest are not text at all. `svg`, `csv`, `txt` and `json` are text and are not here.
 */
export const BINARY_EXTENSIONS: readonly string[] = [
  // images
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico", "icns", "heic", "heif", "tif", "tiff", "psd",
  // documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "epub", "pages", "numbers", "key",
  // archives and disk images
  "zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "rar", "dmg", "iso", "pkg",
  // audio and video
  "mp3", "wav", "m4a", "aac", "ogg", "oga", "opus", "flac", "mp4", "m4v", "mov", "mkv", "webm", "avi", "ogv", "3gp",
  // executables, libraries, compiled output
  "exe", "dll", "so", "dylib", "bin", "class", "jar", "pyc", "o", "a", "wasm",
  // fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // databases
  "sqlite", "sqlite3", "db",
];

const NEVER = new Set<string>([...NEVER_CODE_EXTENSIONS, ...BINARY_EXTENSIONS]);

export type NeverReason = "markdown" | "canvas" | "base" | "binary";

export type FileDecision =
  /** Opens in a Code tab; Obsidian is told about this extension (the registry). */
  | { kind: "extension"; extension: string }
  /** No usable extension (Makefile, Dockerfile, .env): opens through click interception. */
  | { kind: "extensionless" }
  /** Never opens in a Code tab. */
  | { kind: "never"; reason: NeverReason }
  /** Inside `.obsidian`, `.git` or `node_modules`. */
  | { kind: "hidden" }
  /** The extension is on the user's exclude list. */
  | { kind: "excluded"; extension: string };

/** A usable extension: letters, digits and a few joiners; anything else (spaces, dots) is not one. */
const EXTENSION_SHAPE = /^[a-z0-9][a-z0-9_+-]{0,19}$/;

export function fileName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * The lowercase extension without the dot, or "" when there is none. A dotfile whose only dot is
 * the leading one (`.env`, `.gitignore`) has no extension; `.eslintrc.json` has `json`.
 */
export function extensionOf(p: string): string {
  const name = fileName(p);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSION_SHAPE.test(ext) ? ext : "";
}

/** True when the path is, or is inside, `.obsidian`, `.git` or `node_modules`. */
export function isInHiddenFolder(p: string): boolean {
  return p.split("/").some((segment) => HIDDEN_FOLDERS.includes(segment.toLowerCase()));
}

/** The reason an extension never opens in a Code tab, or null when it may. */
export function neverReason(extension: string): NeverReason | null {
  const e = extension.toLowerCase();
  if (e === "md") return "markdown";
  if (e === "canvas") return "canvas";
  if (e === "base") return "base";
  return NEVER.has(e) ? "binary" : null;
}

/** May this extension be handed to Obsidian's registration call? (Never for md, canvas, base or binaries; never when excluded.) */
export function isRegistrable(extension: string, excluded: readonly string[] = []): boolean {
  const e = extension.toLowerCase();
  return EXTENSION_SHAPE.test(e) && neverReason(e) === null && !excluded.includes(e);
}

/** The rule outcome for one vault-relative path. `excluded` holds lowercase extensions without a dot. */
export function decideFile(p: string, excluded: readonly string[] = []): FileDecision {
  if (isInHiddenFolder(p)) return { kind: "hidden" };
  const extension = extensionOf(p);
  if (extension === "") return { kind: "extensionless" };
  const never = neverReason(extension);
  if (never) return { kind: "never", reason: never };
  if (excluded.includes(extension)) return { kind: "excluded", extension };
  return { kind: "extension", extension };
}

/** True when a Code tab may show this file (an extension, or an extensionless file reached by interception). */
export function opensInCodeTab(p: string, excluded: readonly string[] = []): boolean {
  const kind = decideFile(p, excluded).kind;
  return kind === "extension" || kind === "extensionless";
}
