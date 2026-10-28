/**
 * The trust seed (ticket warkworth-36, PR-2, G5/G6/G17): writes VS Code's Workspace Trust record for the vault
 * folder, and only that folder, into the Code tab's browser profile before the workbench page starts, so the tab
 * opens with no Restricted Mode banner. The record's database, store, key and shape are the ones PR-1 measured
 * (docs/spike-extensions.md, "Trust record"). Like `buildBrowserSeedScript` this is a pure string builder: the
 * Code tab runs the script in the webview with `executeJavaScript`.
 *
 * Nothing here switches Workspace Trust off, and nothing here touches a file: the only write is one IndexedDB
 * key on the server's origin.
 */

/** Where VS Code keeps the record, as measured in PR-1 (VS Code 1.145 Insiders). */
export const TRUST_DB_NAME = "vscode-web-state-db-global-shared";
export const TRUST_STORE = "ItemTable";
export const TRUST_KEY = "content.trust.model.key";

/**
 * What the script answers.
 *  - seeded:           the vault folder's record is stored (running it again changes nothing).
 *  - version-mismatch: the stored record is not in the shape PR-1 measured (not JSON, not an object, or its
 *                      `uriTrustInfo` is not a list); it is left exactly as it was.
 *  - no-store:         the database exists but has no `ItemTable` store (VS Code renamed it); it is not touched.
 *  - error:<name>:     anything else the page refused.
 * The Code tab adds `timeout` and `unsupported` (see `runInWebview`).
 */
export type TrustOutcome = "seeded" | "version-mismatch" | "no-store" | `error:${string}`;

export interface TrustSeedInput {
  /** The server's origin, e.g. `http://127.0.0.1:51789`. Its port is always kept. */
  origin: string;
  /** The vault folder as the workbench names it: `vscode-remote://127.0.0.1:51789/Users/dan/My%20Vault` (see `buildFileUri` in src/paths.ts). */
  folderUri: string;
  /** Ports of the servers that are still running. Records for those ports are never removed; an empty list removes nothing. */
  heldPorts: readonly number[];
}

/** One entry of the record's `uriTrustInfo`, in the JSON shape VS Code writes (`$mid: 1` marks a serialized URI). */
export interface TrustEntry {
  uri: { $mid: 1; path: string; scheme: string; authority: string };
  trusted: true;
}

function validPort(p: unknown): p is number {
  return typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;
}

/**
 * The single entry the seed writes. Throws when the input cannot name exactly one folder on the server's own
 * origin: the folder URI is on another host or port than the origin, or its path is empty or the file system
 * root (which would trust everything).
 */
export function trustEntryFor(origin: string, folderUri: string): TrustEntry {
  const o = new URL(origin);
  const u = new URL(folderUri);
  if (u.host !== o.host) throw new Error("the vault folder URI is not on the server's origin");
  // The record holds the decoded path (VS Code revives it with URI.revive); `folderUri` is percent-encoded per segment.
  const decoded = decodeURIComponent(u.pathname).replace(/\/+$/, "");
  if (decoded === "") throw new Error("the vault folder is the file system root; refusing to trust it");
  return { uri: { $mid: 1, path: decoded, scheme: u.protocol.replace(/:$/, ""), authority: u.host }, trusted: true };
}

/** The ports to keep: every valid held port, plus the origin's own. Empty when the held list has no valid port. */
export function keepPorts(origin: string, heldPorts: readonly number[] | null | undefined): number[] {
  const held = Array.isArray(heldPorts) ? heldPorts.filter(validPort) : [];
  if (held.length === 0) return [];
  const own = Number(new URL(origin).port);
  return [...new Set(validPort(own) ? [...held, own] : held)].sort((a, b) => a - b);
}

/**
 * A script for the server's origin (run through `webview.executeJavaScript` before the workbench starts) that
 * puts `entry` into the trust record and drops records for stale ports. Resolves to a `TrustOutcome`.
 *
 *  - Reseeding: the entry for this exact folder on this exact authority is replaced, so any number of runs leave
 *    one record, with the same bytes.
 *  - Only that folder: no other entry is written. Entries for other folders on this server (trusted by hand) and
 *    for ports in the keep list, and anything that is not a `vscode-remote` entry for a `127.0.0.1:<port>`
 *    authority, are kept as they are.
 *  - Stale records (defensive, and in practice a no-op): the browser keeps one database per origin, and every entry
 *    here names this server's own `127.0.0.1:<port>` authority, so a record a server on another port left behind lives
 *    in that origin's database, which this script cannot reach. It stays there, inert, until a server on that port
 *    reseeds it. If an entry for some other `127.0.0.1:<port>` does appear in this database, it is removed unless the
 *    port is in the keep list; with an empty keep list (the held-ports list is empty or missing) nothing is removed.
 *    Removing whole origins' storage from the host was not done: it would also delete that origin's settings and
 *    workbench state, which is more than the trust record.
 *  - Other keys of the stored record are kept.
 */
export function buildTrustSeedScript(input: TrustSeedInput): string {
  const entry = trustEntryFor(input.origin, input.folderUri);
  const keep = keepPorts(input.origin, input.heldPorts);
  return `(async () => {
  const entry = ${JSON.stringify(entry)};
  const keep = ${JSON.stringify(keep)};
  const storeName = ${JSON.stringify(TRUST_STORE)};
  const key = ${JSON.stringify(TRUST_KEY)};
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(${JSON.stringify(TRUST_DB_NAME)});
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(storeName)) r.result.createObjectStore(storeName); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  } catch (e) {
    return "error:" + ((e && e.name) || "open");
  }
  try {
    if (!db.objectStoreNames.contains(storeName)) return "no-store";
    const same = (a, b) => a.scheme === b.scheme && a.authority === b.authority && a.path === b.path;
    const stale = (e) => {
      const uri = e && e.uri;
      if (keep.length === 0 || !uri || uri.scheme !== entry.uri.scheme || typeof uri.authority !== "string") return false;
      const m = /^127\\.0\\.0\\.1:(\\d+)$/.exec(uri.authority);
      return m !== null && keep.indexOf(Number(m[1])) < 0;
    };
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      let outcome = "seeded";
      const q = store.get(key);
      q.onsuccess = () => {
        let model = { uriTrustInfo: [] };
        if (q.result !== undefined) {
          try { model = typeof q.result === "string" ? JSON.parse(q.result) : null; } catch (e) { model = null; }
          if (model === null || typeof model !== "object" || Array.isArray(model) || (model.uriTrustInfo !== undefined && !Array.isArray(model.uriTrustInfo))) {
            outcome = "version-mismatch";
            return;
          }
        }
        const kept = (model.uriTrustInfo || []).filter((e) => !(e && e.uri && same(e.uri, entry.uri)) && !stale(e));
        store.put(JSON.stringify(Object.assign({}, model, { uriTrustInfo: kept.concat([entry]) })), key);
      };
      q.onerror = () => reject(q.error);
      tx.oncomplete = () => resolve(outcome);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch (e) {
    return "error:" + ((e && e.name) || "seed");
  } finally {
    db.close();
  }
})()`;
}
