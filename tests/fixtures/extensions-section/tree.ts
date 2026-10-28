/**
 * The Extensions list fixtures, in one place: a profile `extensions.json` with eight extensions (two of them
 * Microsoft-only), their package.json files, and sample extension host logs (healthy, failing, empty).
 * `makeTree` lays them out the way the plugin finds them: an instance extensions folder, the plugin's server
 * data dir built by the real `shareExtensions`, and a log under `data/logs/<run>/exthost<N>/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { shareExtensions } from "../../../src/server";
import type { ExtensionListInput } from "../../../src/settings/extension-list";
import type { MirrorResult } from "../../../src/mirror/mirror";
import { enabledExtensions, parseProfileExtensions, type MirrorState } from "../../../src/server/shared-extensions";
import { tempDir } from "../../helpers";

export const DIR = __dirname;

/** The eight extensions of the fixture profile, as ids. `ChakrounAnas.turbo-console-log` is written in mixed case on purpose. */
export const IDS = {
  turbo: "ChakrounAnas.turbo-console-log",
  python: "ms-python.python",
  pylance: "ms-python.vscode-pylance",
  cpptools: "ms-vscode.cpptools",
  prettier: "esbenp.prettier-vscode",
  eslint: "dbaeumer.vscode-eslint",
  gitlens: "eamodio.gitlens",
  yaml: "redhat.vscode-yaml",
} as const;

export const ALL_IDS = Object.values(IDS);

export const extensionsJsonText = () => fs.readFileSync(path.join(DIR, "extensions.json"), "utf8");
export const logText = (name: "healthy" | "failing" | "empty") => fs.readFileSync(path.join(DIR, `${name}.log`), "utf8");

interface PackageName {
  displayName: string;
  nls?: Record<string, string>;
}
const packageNames = JSON.parse(fs.readFileSync(path.join(DIR, "package-names.json"), "utf8")) as Record<string, PackageName>;

export interface TreeOptions {
  /** Ids desktop VS Code has switched off. */
  disabled?: string[];
  /** Replaces the fixture's `extensions.json` text. */
  extensionsJson?: string;
  /** Host logs to write for the run: folder name (`exthost1`) to text. Default: none. */
  logs?: Record<string, string>;
  /** The run folder the logs go in. */
  run?: string;
}

export interface Tree {
  root: string;
  serverDataDir: string;
  /** The instance's extensions folder (the source of the links). */
  sourceDir: string;
  mirror: MirrorState;
  /** Write a host log into a run folder. */
  writeLog(run: string, host: string, text: string): string;
}

/** The disabled lists as a read gave them. */
export const readResult = (disabled: string[]): MirrorResult => ({
  source: "read",
  disabled: disabled.map((d) => d.toLowerCase()).sort(),
  counts: { global: disabled.length, profile: null, workspace: 0 },
  notes: [],
  at: 1_800_000_000_000,
});

export function makeTree(opts: TreeOptions = {}): Tree {
  const root = tempDir("ext-section-");
  const sourceDir = path.join(root, "instance-extensions");
  const serverDataDir = path.join(root, "server-data");
  fs.mkdirSync(sourceDir, { recursive: true });
  const text = opts.extensionsJson ?? extensionsJsonText();
  const parsed = parseProfileExtensions(text);
  if (!parsed.ok) throw new Error(parsed.why);
  for (const ext of parsed.extensions) {
    const dir = path.join(sourceDir, ext.folder);
    fs.mkdirSync(dir, { recursive: true });
    const names = packageNames[ext.id];
    const pkg: Record<string, unknown> = { name: ext.id.split(".")[1], version: String(ext.entry.version ?? "0.0.0") };
    if (names) pkg.displayName = names.displayName;
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    if (names?.nls) fs.writeFileSync(path.join(dir, "package.nls.json"), JSON.stringify(names.nls));
  }
  const mirror: MirrorState = { disabled: readResult(opts.disabled ?? []), extensions: parsed };
  // The real sharing step, so the links are the ones a server start makes.
  shareExtensions(sourceDir, serverDataDir, enabledExtensions(mirror));
  const writeLog = (run: string, host: string, content: string): string => {
    const file = path.join(serverDataDir, "data", "logs", run, host, "remoteexthost.log");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  for (const [host, content] of Object.entries(opts.logs ?? {})) writeLog(opts.run ?? "20261028T090000", host, content);
  return { root, serverDataDir, sourceDir, mirror, writeLog };
}

/** The plugin's input for a running server on this tree; `over` replaces any field. */
export function runningInput(tree: Tree, over: Partial<ExtensionListInput> = {}): ExtensionListInput {
  return { serverRunning: true, serverDataDir: tree.serverDataDir, sourceDir: tree.sourceDir, mirror: tree.mirror, trustSeedOn: true, trustOutcome: "seeded", ...over };
}
