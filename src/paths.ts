/**
 * URL building for the VS Code web workbench served by `code serve-web`.
 * Every user-controlled piece (vault path, file path) is percent-encoded here
 * and nowhere else, so spaces, `#`, `?`, `%`, accents, CJK and emoji survive.
 */

/** Join the vault root and a vault-relative path into an absolute path (POSIX). */
export function toAbsolutePath(vaultRoot: string, relativePath: string): string {
  const root = vaultRoot.replace(/\/+$/, "");
  const rel = relativePath.replace(/^\/+/, "");
  return rel ? `${root}/${rel}` : root || "/";
}

/** Percent-encode each path segment, keeping the `/` separators. */
export function encodePathSegments(absPath: string): string {
  return absPath.split("/").map(encodeURIComponent).join("/");
}

/** Host and port of the server, e.g. `127.0.0.1:61092`, taken from its base URL. */
export function authorityOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

/** `vscode-remote://<authority>/<encoded path>`: how the workbench names a file on the server. */
export function buildFileUri(baseUrl: string, absPath: string): string {
  return `vscode-remote://${authorityOf(baseUrl)}${encodePathSegments(absPath)}`;
}

function query(parts: Array<[string, string | undefined]>): string {
  return parts
    .filter((p): p is [string, string] => p[1] !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

/** Workbench URL showing the vault folder (no file). The token is the caller's secret: keep the URL out of logs. */
export function buildFolderUrl(baseUrl: string, vaultRoot: string, token?: string): string {
  return `${baseUrl}/?${query([
    ["tkn", token],
    ["folder", vaultRoot],
  ])}`;
}

/** Workbench URL showing the vault folder with one file open. */
export function buildFileUrl(baseUrl: string, vaultRoot: string, relativePath: string, token?: string): string {
  const fileUri = buildFileUri(baseUrl, toAbsolutePath(vaultRoot, relativePath));
  return `${baseUrl}/?${query([
    ["tkn", token],
    ["folder", vaultRoot],
    ["payload", JSON.stringify([["openFile", fileUri]])],
  ])}`;
}

/**
 * The line a file is opened at, from whatever the caller was given (a number, or text read off the page): a whole number of 1
 * or more. Zero, a negative number, text that is not a number, NaN and infinity give 1. A line past the end of the file is not
 * known here; VS Code's Go to Line puts the cursor on the last line for it.
 */
export function normalizeLine(value: unknown): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  const whole = Math.floor(n);
  return whole >= 1 ? Math.min(whole, Number.MAX_SAFE_INTEGER) : 1;
}

/** What a file URI the editor reported is, for this vault. */
export type EditorTarget =
  /** A file inside the vault: `file` is the vault-relative path, decoded. */
  | { kind: "vault"; file: string }
  /** A file on this machine outside the vault (an absolute path elsewhere, a `node_modules` type definition elsewhere, a path above the vault root). */
  | { kind: "outside"; path: string }
  /** Not a file of this server: another scheme or server, or text that is not a URI. */
  | { kind: "other" };

/**
 * Read a file URI the workbench reports (`vscode-remote://127.0.0.1:5555/Users/dan/My%20Vault/a%20b.py`, the inverse of
 * `buildFileUri`) back into a path. `authority` is the server's host and port, so a URI of another server is `other`. A path
 * that climbs out of the vault with `..` is outside. Nothing is read from disk here.
 */
export function targetOfUri(uri: string, authority: string, vaultRoot: string): EditorTarget {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { kind: "other" };
  }
  if (url.protocol !== "vscode-remote:" || url.host !== authority) return { kind: "other" };
  let decoded: string;
  try {
    decoded = url.pathname.split("/").map(decodeURIComponent).join("/");
  } catch {
    return { kind: "other" }; // a stray % that is not an escape
  }
  const parts: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  const abs = `/${parts.join("/")}`;
  const root = vaultRoot.replace(/\/+$/, "");
  if (root !== "" && abs.startsWith(`${root}/`)) return { kind: "vault", file: abs.slice(root.length + 1) };
  if (root === "" && abs !== "/") return { kind: "vault", file: abs.slice(1) }; // a vault at the file system root
  return { kind: "outside", path: abs };
}
