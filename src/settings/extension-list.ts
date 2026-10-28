/**
 * The rows of the Extensions list (G3, G4, G11, G16, E4, E5): every extension the mirrored profile lists, with
 * its name, id, version, state and reason. It is built when the settings tab opens, from
 *   - the Mirror state the last server start kept (the profile's extension list and the disabled lists),
 *   - the plugin's own links under `<server data dir>/extensions` (and, for an extension desktop VS Code has
 *     switched off and so is not linked, its folder in the instance's extensions folder),
 *   - the trust outcome the host holds, and
 *   - the extension host log (src/settings/exthost-log.ts), read now.
 * Nothing is kept between calls and nothing is written (F1, F7); an extension whose folder is gone is left out
 * and no failure reaches the caller. The list has no control: it reports (F2).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MirrorState, ProfileExtension } from "../server/shared-extensions";
import { cleanText, resolveState, type ExtensionListView, type ExtensionRow, type LogFacts } from "./extension-states";
import { readExtHostLog, type ExtHostLogRead, type ReadOptions } from "./exthost-log";

export interface ExtensionListInput {
  /** The server is up (its state is `running`). */
  serverRunning: boolean;
  /** The plugin's server data dir; null when there is no server object. */
  serverDataDir: string | null;
  /** The instance's own extensions folder (read only, for the name and version of a switched-off extension); null when unknown. */
  sourceDir: string | null;
  /** What the last server start read of desktop VS Code; null when it has not read yet. */
  mirror: MirrorState | null;
  /** The trust setting is on, so the plugin seeds trust at each tab load. */
  trustSeedOn: boolean;
  /** What the trust seed answered at the last tab load; null = no tab has run it yet. */
  trustOutcome: string | null;
}

/** The file access the list needs (read only). */
export interface ListFs {
  isDirectory(p: string): Promise<boolean>;
  /** A small JSON file, or null when it is missing, too large or not JSON. */
  readJson(p: string): Promise<unknown>;
}

const MAX_JSON_BYTES = 1024 * 1024;

export const realListFs: ListFs = {
  async isDirectory(p) {
    try {
      return (await fs.stat(p)).isDirectory(); // follows a link: a dangling one throws
    } catch {
      return false;
    }
  },
  async readJson(p) {
    try {
      const stat = await fs.stat(p);
      if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return null;
      const text = await fs.readFile(p, "utf8");
      return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      return null;
    }
  },
};

export interface ListDeps {
  fs?: ListFs;
  log?: ReadOptions;
  /** Tests only: replaces the log reader. */
  readLog?: (serverDataDir: string, ids: ReadonlySet<string>) => Promise<ExtHostLogRead>;
}

const NO_EXTENSIONS = "No extensions shared";

const empty = (reason: string): ExtensionListView => ({ status: "empty", message: NO_EXTENSIONS, reason });

const asString = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The part of `publisher.name` after the first dot: what the row shows when the extension names itself nothing better. */
const nameFromId = (id: string): string => (id.includes(".") ? id.slice(id.indexOf(".") + 1) : id);

/** `%key%` is a look-up in package.nls.json (a value, or `{ message }`). */
async function localised(io: ListFs, dir: string, value: string): Promise<string | null> {
  const m = /^%(.+)%$/.exec(value);
  if (!m) return value;
  const nls = asRecord(await io.readJson(path.join(dir, "package.nls.json")));
  const hit = nls?.[m[1]];
  return asString(hit) ?? asString(asRecord(hit)?.message);
}

interface Located {
  ext: ProfileExtension;
  off: boolean;
  /** Where the extension's files are; null = not known (a switched-off extension when the instance's folder is not known). */
  dir: string | null;
}

async function describe(io: ListFs, l: Located): Promise<{ id: string; name: string; version: string }> {
  const identifier = asRecord(l.ext.entry.identifier);
  const id = cleanText(asString(identifier?.id) ?? l.ext.id, 120) ?? l.ext.id;
  const dir = l.dir;
  const pkg = dir === null ? null : asRecord(await io.readJson(path.join(dir, "package.json")));
  const display = asString(pkg?.displayName);
  const name = cleanText((display && dir !== null ? await localised(io, dir, display) : null) ?? nameFromId(id), 80) ?? nameFromId(id);
  // The profile's own entry is the source for the version; the extension's package.json and then the folder name back it up.
  const fromFolder = l.ext.folder.toLowerCase().startsWith(`${l.ext.id}-`) ? l.ext.folder.slice(l.ext.id.length + 1) : null;
  const version = cleanText(asString(l.ext.entry.version) ?? asString(pkg?.version) ?? fromFolder ?? "unknown", 40) ?? "unknown";
  return { id, name, version };
}

/**
 * Everything the section draws under its heading. Never throws: any failure becomes an empty list with a
 * reason, or leaves the extension out.
 */
export async function buildExtensionList(input: ExtensionListInput, deps: ListDeps = {}): Promise<ExtensionListView> {
  try {
    return await build(input, deps);
  } catch {
    return empty("the list could not be read");
  }
}

async function build(input: ExtensionListInput, deps: ListDeps): Promise<ExtensionListView> {
  const { serverDataDir, mirror } = input;
  // No server: runtime states cannot be told, and nothing from an earlier run is shown.
  if (!input.serverRunning || serverDataDir === null) return { status: "server-not-running" };
  if (mirror === null) return empty("nothing was read from desktop VS Code at the last server start");
  if (mirror.disabled.source === "none") return empty(mirror.disabled.why);
  if (!mirror.extensions.ok) return empty(mirror.extensions.why);

  const io = deps.fs ?? realListFs;
  const off = new Set(mirror.disabled.disabled.map((d) => d.trim().toLowerCase()));
  const listed = mirror.extensions.extensions;

  // One entry per id (the first the profile points at whose folder is there). A folder that is gone, or a link
  // that dangles, leaves the extension out (E5).
  const located: Located[] = [];
  const seen = new Set<string>();
  for (const ext of listed) {
    if (seen.has(ext.id)) continue;
    const isOff = off.has(ext.id);
    // A switched-off extension is not linked; its folder in the instance's extensions folder is read, never changed.
    // With that folder unknown it is still listed (by its id), since desktop VS Code's own list says it exists.
    const dir = isOff ? (input.sourceDir ? path.join(input.sourceDir, ext.folder) : null) : path.join(serverDataDir, "extensions", ext.folder);
    if (dir !== null && !(await io.isDirectory(dir))) continue;
    seen.add(ext.id);
    located.push({ ext, off: isOff, dir });
  }
  if (located.length === 0) return empty(listed.length === 0 ? "the profile lists no extensions" : "none of the profile's extension folders could be found");

  const ids = new Set(located.map((l) => l.ext.id));
  const log = deps.readLog ? await deps.readLog(serverDataDir, ids) : await readExtHostLog(serverDataDir, ids, deps.log);
  const untrusted = input.trustSeedOn && input.trustOutcome !== null && input.trustOutcome !== "seeded";

  const rows: ExtensionRow[] = await Promise.all(
    located.map(async (l): Promise<ExtensionRow> => {
      const fact = log.found ? log.facts.get(l.ext.id) : undefined;
      const facts: LogFacts = log.found ? { found: true, failed: fact?.kind === "failed" ? { reason: fact.reason } : null, activated: fact?.kind === "active" } : { found: false };
      const resolved = resolveState({ disabled: l.off, untrusted, log: facts });
      return { ...(await describe(io, l)), state: resolved.state, stateLabel: resolved.label, reason: resolved.reason };
    }),
  );
  rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
  return { status: "listed", rows };
}
