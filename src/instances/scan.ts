/**
 * Finding VS Code builds (G15). The scan reads the app folders (`/Applications`
 * and `~/Applications`) and lists a build only if its CLI passes the serve-web
 * probe. It only reads: nothing under an app bundle or a VS Code data folder
 * is written, renamed, deleted or chmod-ed (F3).
 *
 * A build is classified by its bundle identifier (Info.plist, else
 * product.json), never by the folder name: here `Visual Studio Code.app` is
 * really VS Code Insiders.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chooseInstance } from "./choose";
import { probeServeWeb, type ProbeResult } from "./probe";

export type InstanceKind = "vscode" | "vscode-insiders" | "vscodium" | "antigravity" | "antigravity-ide" | "custom";

export interface KnownBuild {
  kind: Exclude<InstanceKind, "custom">;
  label: string;
  bundleIds: string[];
  /** CLI file names inside `Contents/Resources/app/bin`, tried in order. */
  cliNames: string[];
  /** Folder under `~/Library/Application Support` that holds the build's `User/` folder. */
  userDataName: string;
  /** Microsoft's own build: its Microsoft-only extensions are expected to run (E8). */
  microsoft: boolean;
}

export const KNOWN_BUILDS: readonly KnownBuild[] = [
  { kind: "vscode", label: "VS Code", bundleIds: ["com.microsoft.VSCode"], cliNames: ["code"], userDataName: "Code", microsoft: true },
  {
    kind: "vscode-insiders",
    label: "VS Code Insiders",
    bundleIds: ["com.microsoft.VSCodeInsiders"],
    cliNames: ["code", "code-insiders"],
    userDataName: "Code - Insiders",
    microsoft: true,
  },
  { kind: "vscodium", label: "VSCodium", bundleIds: ["com.vscodium"], cliNames: ["codium"], userDataName: "VSCodium", microsoft: false },
  { kind: "antigravity", label: "Antigravity", bundleIds: ["com.google.antigravity"], cliNames: ["antigravity"], userDataName: "Antigravity", microsoft: false },
  {
    kind: "antigravity-ide",
    label: "Antigravity IDE",
    bundleIds: ["com.google.antigravity-ide"],
    cliNames: ["antigravity-ide"],
    userDataName: "Antigravity IDE",
    microsoft: false,
  },
];

export interface Instance {
  /** Stable id of this install, saved in data.json when chosen. */
  id: string;
  kind: InstanceKind;
  label: string;
  /** product.json `version`, e.g. `1.144.0-insider`; "" when unknown. */
  version: string;
  /** The folder under Application Support holding the instance's `User/` folder; null when it cannot be told. */
  userDataName: string | null;
  cli: string;
  /** The app bundle; null for a custom CLI path that is not inside one. */
  appPath: string | null;
  microsoft: boolean;
}

export interface RejectedBuild {
  label: string;
  appPath: string;
  reason: string;
}

export interface ScanResult {
  instances: Instance[];
  /** Known builds that were found but not offered, with the reason. */
  rejected: RejectedBuild[];
  /** The saved custom CLI path was given but is not usable now: the reason. */
  customFailure: string | null;
}

export const SCAN_TIMEOUT_MS = 10_000;
export const CUSTOM_ID = "custom";

/** The folders scanned. `WORKBENCH_SCAN_ROOTS` (colon-separated) replaces them; it exists for tests only. */
export function scanRoots(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string[] {
  const override = env.WORKBENCH_SCAN_ROOTS;
  if (override !== undefined) return override.split(path.delimiter).filter((r) => r !== "");
  return ["/Applications", path.join(home, "Applications")];
}

/** The folder holding the instances' user folders. `WORKBENCH_APP_SUPPORT_ROOT` replaces it (tests only). */
export function appSupportRoot(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.WORKBENCH_APP_SUPPORT_ROOT ?? path.join(home, "Library", "Application Support");
}

interface ProductInfo {
  version?: string;
  nameShort?: string;
  darwinBundleIdentifier?: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readProduct(appResourcesDir: string): ProductInfo {
  const raw = readJson(path.join(appResourcesDir, "product.json"));
  if (typeof raw !== "object" || raw === null) return {};
  const p = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { version: str(p.version), nameShort: str(p.nameShort), darwinBundleIdentifier: str(p.darwinBundleIdentifier) };
}

/** CFBundleIdentifier from an XML Info.plist; null when the file is missing or not XML. */
export function bundleIdFromPlist(plistPath: string): string | null {
  try {
    const text = fs.readFileSync(plistPath, "utf8");
    const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A folder name usable as a child of Application Support (no separators, no `..`). */
function safeFolderName(name: string | undefined): string | null {
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) return null;
  return name;
}

/** Which known build an app bundle is, by bundle identifier. null for any other app. */
export function classifyBundle(appPath: string): { known: KnownBuild; product: ProductInfo } | null {
  const product = readProduct(path.join(appPath, "Contents", "Resources", "app"));
  const ids = [bundleIdFromPlist(path.join(appPath, "Contents", "Info.plist")), product.darwinBundleIdentifier].filter((x): x is string => !!x);
  for (const id of ids) {
    const known = KNOWN_BUILDS.find((k) => k.bundleIds.includes(id));
    if (known) return { known, product };
  }
  return null;
}

function labelOf(base: string, version: string): string {
  return version ? `${base} ${version}` : base;
}

export interface ScanOptions {
  roots?: string[];
  env?: NodeJS.ProcessEnv;
  /** A custom CLI path saved earlier; probed like the rest and listed as "Custom". */
  customCliPath?: string | null;
  probeTimeoutMs?: number;
  /** The whole scan answers by this time with whatever has finished (default 10 s). */
  scanTimeoutMs?: number;
  probe?: (cli: string, o: { timeoutMs?: number }) => Promise<ProbeResult>;
}

/** Look at one app bundle: an instance still to probe, a rejection, or null (not a known build). */
function inspectApp(appPath: string): { instance: Instance } | { rejected: RejectedBuild } | null {
  const cls = classifyBundle(appPath);
  if (!cls) return null;
  const { known, product } = cls;
  const version = product.version ?? "";
  const label = labelOf(known.label, version);
  const binDir = path.join(appPath, "Contents", "Resources", "app", "bin");
  if (!isDir(binDir)) return { rejected: { label, appPath, reason: "it has no Contents/Resources/app/bin folder." } };
  const name = known.cliNames.find((n) => isFile(path.join(binDir, n)));
  if (!name) return { rejected: { label, appPath, reason: `none of ${known.cliNames.join(", ")} is in its bin folder.` } };
  const cli = path.join(binDir, name);
  if (!isExecutable(cli)) return { rejected: { label, appPath, reason: `${name} is not executable.` } };
  return {
    instance: {
      id: `${known.kind}:${appPath}`,
      kind: known.kind,
      label,
      version,
      userDataName: known.userDataName,
      cli,
      appPath,
      microsoft: known.microsoft,
    },
  };
}

/** Describe a custom CLI: what the app it sits in says, else just "Custom". */
export function describeCustom(cli: string): Instance {
  let real = cli;
  try {
    real = fs.realpathSync(cli);
  } catch {
    /* keep the typed path */
  }
  const product = readProduct(path.dirname(path.dirname(real))); // .../app/bin/<cli> -> .../app
  const m = /^(.*?\.app)(?:\/|$)/.exec(real);
  const appPath = m ? m[1] : null;
  const cls = appPath ? classifyBundle(appPath) : null;
  const version = product.version ?? "";
  return {
    id: CUSTOM_ID,
    kind: cls?.known.kind ?? "custom",
    label: labelOf("Custom", version),
    version,
    userDataName: cls?.known.userDataName ?? safeFolderName(product.nameShort),
    cli,
    appPath,
    microsoft: cls ? cls.known.microsoft : true,
  };
}

/** The checks on a saved custom CLI that need no process: it exists, is a file and is executable. */
function precheckCustom(custom: string): { instance: Instance } | { failure: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(custom);
  } catch {
    return { failure: "the file no longer exists." };
  }
  if (stat.isDirectory()) return { failure: "the path is a folder." };
  if (!isExecutable(custom)) return { failure: "the file is not executable." };
  return { instance: describeCustom(custom) };
}

async function checkCustom(custom: string, probe: NonNullable<ScanOptions["probe"]>, probeOpts: { timeoutMs?: number }): Promise<{ instance: Instance } | { failure: string }> {
  const pre = precheckCustom(custom);
  if ("failure" in pre) return pre;
  const r = await probe(custom, probeOpts);
  return r.ok ? pre : { failure: r.reason };
}

/** Everything a scan learns without running a process: the builds still to probe and the ones rejected on sight. */
function collectBuilds(roots: string[]): { toProbe: Instance[]; rejected: RejectedBuild[] } {
  const rejected: RejectedBuild[] = [];
  const toProbe: Instance[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let names: string[];
    try {
      names = fs.readdirSync(root).filter((n) => n.toLowerCase().endsWith(".app"));
    } catch {
      continue; // a missing root (no ~/Applications) is normal
    }
    for (const name of names.sort()) {
      const appPath = path.join(root, name);
      const found = inspectApp(appPath);
      if (!found) continue;
      if ("rejected" in found) {
        rejected.push(found.rejected);
        continue;
      }
      let key = found.instance.cli;
      try {
        key = fs.realpathSync(key);
      } catch {
        /* keep */
      }
      if (seen.has(key)) continue; // the same install reached through two roots or a link
      seen.add(key);
      toProbe.push(found.instance);
    }
  }
  return { toProbe, rejected };
}

/**
 * Scan for VS Code builds and probe each CLI (in parallel). Never throws, and
 * answers within `scanTimeoutMs` whatever the probes do.
 */
export async function scanInstances(opts: ScanOptions = {}): Promise<ScanResult> {
  const env = opts.env ?? process.env;
  const roots = opts.roots ?? scanRoots(env);
  const probe = opts.probe ?? probeServeWeb;
  const probeOpts = { timeoutMs: opts.probeTimeoutMs };
  const { toProbe, rejected } = collectBuilds(roots);

  const instances: Instance[] = [];
  let customFailure: string | null = null;
  const work: Array<Promise<void>> = toProbe.map(async (instance) => {
    const r = await probe(instance.cli, probeOpts);
    if (r.ok) instances.push(instance);
    else rejected.push({ label: instance.label, appPath: instance.appPath ?? instance.cli, reason: `its serve-web check failed: ${r.reason}` });
  });
  const custom = opts.customCliPath?.trim();
  if (custom) {
    work.push(
      checkCustom(custom, probe, probeOpts).then((r) => {
        if ("instance" in r) instances.push(r.instance);
        else customFailure = r.failure;
      }),
    );
  }

  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    deadline = setTimeout(resolve, opts.scanTimeoutMs ?? SCAN_TIMEOUT_MS);
    (deadline as { unref?: () => void }).unref?.();
  });
  await Promise.race([Promise.all(work).then(() => undefined), timedOut]);
  if (deadline) clearTimeout(deadline);

  const order = (i: Instance) => (i.id === CUSTOM_ID ? 99 : KNOWN_BUILDS.findIndex((b) => b.kind === i.kind));
  const sorted = [...instances].sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id));
  return { instances: sorted, rejected: [...rejected].sort((a, b) => a.appPath.localeCompare(b.appPath)), customFailure };
}

export interface StartScanOptions extends ScanOptions {
  /** The instance saved in data.json, or null for the default. */
  savedId: string | null;
}

/**
 * The instance a server start runs on, probing only what the choice needs. The builds are listed from
 * disk (no process), `chooseInstance` names the one it would pick (the saved one, else the newest VS Code),
 * and only that one is probed; a build that fails its probe is dropped and the choice is made again among
 * the rest. The result is the instance a full scan followed by `chooseInstance` would give, but a hanging
 * build that was never going to be chosen costs the start nothing. null when nothing usable is found
 * (or the time limit runs out first).
 */
export async function resolveInstanceForStart(opts: StartScanOptions): Promise<Instance | null> {
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? probeServeWeb;
  const probeOpts = { timeoutMs: opts.probeTimeoutMs };
  const { toProbe, rejected } = collectBuilds(opts.roots ?? scanRoots(env));
  const pool = [...toProbe];
  let customFailure: string | null = null;
  const custom = opts.customCliPath?.trim();
  if (custom) {
    const pre = precheckCustom(custom);
    if ("instance" in pre) pool.push(pre.instance);
    else customFailure = pre.failure;
  }
  const until = Date.now() + (opts.scanTimeoutMs ?? SCAN_TIMEOUT_MS);
  while (pool.length > 0 && Date.now() < until) {
    const next = chooseInstance({ instances: pool, rejected, customFailure }, opts.savedId).selected;
    if (!next) return null;
    if ((await probe(next.cli, probeOpts)).ok) return next;
    pool.splice(pool.indexOf(next), 1);
  }
  return null;
}
