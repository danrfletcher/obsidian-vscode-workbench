/** Builders for fake VS Code app bundles and user folders used by the instance tests. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface FakeApp {
  /** Folder name, e.g. `Visual Studio Code.app` (it need not match the build: classification is by bundle id). */
  name: string;
  bundleId: string;
  version: string;
  /** CLI file name in `Contents/Resources/app/bin`; null = no bin folder at all. */
  cli: string | null;
  /** The CLI's content; null = the bin folder exists but the file does not. */
  script?: string | null;
  mode?: number;
  nameShort?: string;
  dataFolderName?: string;
  /** Write Info.plist (default true) / product.json (default true). */
  plist?: boolean;
  product?: boolean;
}

/** Answers `serve-web --help` like a real CLI. */
export const PASS_SCRIPT = `#!/bin/sh
if [ "$1" = "serve-web" ] && [ "$2" = "--help" ]; then
  echo "Runs a local web version of Visual Studio Code"
  echo "Usage: code-tunnel serve-web [OPTIONS]"
  exit 0
fi
exit 9
`;
export const EXIT1_SCRIPT = `#!/bin/sh\necho "serve-web is not available" >&2\nexit 1\n`;
/** Exit 0 but print nothing. */
export const SILENT_SCRIPT = `#!/bin/sh\nexit 0\n`;
/** Exit 0 and print help that does not mention serve-web. */
export const NO_MENTION_SCRIPT = `#!/bin/sh\necho "usage: code [options]"\nexit 0\n`;
/** Runs the helper that is missing, like Antigravity IDE's launcher (ENOENT). */
export const MISSING_HELPER_SCRIPT = `#!/bin/sh\nexec "$(dirname "$0")/antigravity-tunnel" "$@"\n`;
/** Records its pid in $HANG_PIDFILE, then hangs. */
export const HANG_SCRIPT = `#!/bin/sh\necho $$ > "$HANG_PIDFILE"\nexec sleep 60\n`;

export function plist(bundleId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleIdentifier</key>\n\t<string>${bundleId}</string>\n</dict>\n</plist>\n`;
}

/** Create one fake bundle under `root`; returns the app folder. */
export function makeApp(root: string, app: FakeApp): string {
  const appPath = path.join(root, app.name);
  const res = path.join(appPath, "Contents", "Resources", "app");
  fs.mkdirSync(res, { recursive: true });
  if (app.plist !== false) fs.writeFileSync(path.join(appPath, "Contents", "Info.plist"), plist(app.bundleId));
  if (app.product !== false) {
    fs.writeFileSync(
      path.join(res, "product.json"),
      JSON.stringify({ version: app.version, dataFolderName: app.dataFolderName ?? ".vscode", nameShort: app.nameShort, darwinBundleIdentifier: app.bundleId }),
    );
  }
  if (app.cli !== null) {
    const bin = path.join(res, "bin");
    fs.mkdirSync(bin, { recursive: true });
    if (app.script !== null) fs.writeFileSync(path.join(bin, app.cli), app.script ?? PASS_SCRIPT, { mode: app.mode ?? 0o755 });
  }
  return appPath;
}

/** The five known builds with a passing CLI, under `root`. */
export function makeAllKnown(root: string): Record<string, string> {
  return {
    vscode: makeApp(root, { name: "Visual Studio Code.app", bundleId: "com.microsoft.VSCode", version: "1.143.1", cli: "code", nameShort: "Code" }),
    insiders: makeApp(root, { name: "Visual Studio Code - Insiders.app", bundleId: "com.microsoft.VSCodeInsiders", version: "1.144.0-insider", cli: "code", nameShort: "Code - Insiders" }),
    vscodium: makeApp(root, { name: "VSCodium.app", bundleId: "com.vscodium", version: "1.140.0", cli: "codium", nameShort: "VSCodium" }),
    antigravity: makeApp(root, { name: "Antigravity.app", bundleId: "com.google.antigravity", version: "1.2.0", cli: "antigravity", nameShort: "Antigravity" }),
    antigravityIde: makeApp(root, { name: "Antigravity IDE.app", bundleId: "com.google.antigravity-ide", version: "1.3.0", cli: "antigravity-ide", nameShort: "Antigravity IDE" }),
  };
}

/** Every file under `dir` (and the dirs, links and modes), hashed: a change anywhere changes the digest. */
export function treeDigest(dir: string): string {
  const h = crypto.createHash("sha256");
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      h.update(`${path.relative(dir, p)}|${st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "f"}|${(st.mode & 0o7777).toString(8)}|${st.isFile() ? st.size : 0}\n`);
      if (st.isSymbolicLink()) h.update(fs.readlinkSync(p));
      else if (st.isDirectory()) walk(p);
      else h.update(fs.readFileSync(p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return h.digest("hex");
}

/** Remove write permission from a whole tree, so any write, rename or delete inside it fails. */
export function makeReadOnly(dir: string): void {
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else fs.chmodSync(p, st.mode & ~0o222);
    }
    fs.chmodSync(d, fs.statSync(d).mode & ~0o222);
  };
  walk(dir);
}

/** Restore write permission (so the temp dir can be removed). */
export function makeWritable(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const walk = (d: string) => {
    fs.chmodSync(d, fs.statSync(d).mode | 0o700);
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else fs.chmodSync(p, st.mode | 0o600);
    }
  };
  walk(dir);
}
