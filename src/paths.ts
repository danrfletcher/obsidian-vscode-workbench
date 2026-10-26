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
