import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, tempDir } from "../helpers";

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
const allDeps = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
  ...pkg.optionalDependencies,
  ...pkg.peerDependencies,
};
const names = Object.keys(allDeps);

/** Names that would mean a fallback editor (F2), a native module (F9) or tracking (F5). */
const FORBIDDEN_EDITOR = /^(monaco-editor|@monaco-editor\/.*|codemirror|@codemirror\/.*|@uiw\/.*codemirror.*|cm-.*|code-?mirror.*)$/;
const FORBIDDEN_NATIVE = /^(node-pty|node-pty-prebuilt.*|@homebridge\/node-pty.*|nodegit|better-sqlite3|sqlite3|fsevents|node-gyp|bindings|nan|node-addon-api)$/;
const FORBIDDEN_TRACKING =
  /(analytics|telemetry|tracking|sentry|posthog|mixpanel|segment|amplitude|bugsnag|datadog|rollbar|logrocket|hotjar|fullstory|appinsights|applicationinsights|gtag|plausible|matomo)/i;

/** True when the package dir has a binding.gyp, `gypfile`, or a .node binary (top level or build/). */
function isNativePackage(dir: string): string | null {
  if (fs.existsSync(path.join(dir, "binding.gyp"))) return "binding.gyp";
  const json = path.join(dir, "package.json");
  if (fs.existsSync(json)) {
    const p = JSON.parse(fs.readFileSync(json, "utf8")) as { gypfile?: boolean };
    if (p.gypfile) return "gypfile";
  }
  for (const sub of [dir, path.join(dir, "build", "Release"), path.join(dir, "prebuilds")]) {
    if (fs.existsSync(sub) && fs.readdirSync(sub).some((f) => f.endsWith(".node"))) return ".node binary";
  }
  return null;
}

/** Runtime (shipped) packages: dependencies + optionalDependencies, transitively, from node_modules. */
function runtimeClosure(): string[] {
  const seen = new Set<string>();
  const queue = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies });
  while (queue.length) {
    const n = queue.shift() as string;
    if (seen.has(n)) continue;
    seen.add(n);
    const j = path.join(REPO_ROOT, "node_modules", n, "package.json");
    if (!fs.existsSync(j)) continue;
    const p = JSON.parse(fs.readFileSync(j, "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
    queue.push(...Object.keys({ ...p.dependencies, ...p.optionalDependencies }));
  }
  return [...seen];
}

describe("package.json dependencies", () => {
  it("has no Monaco or CodeMirror editor packages (F2)", () => {
    expect(names.filter((n) => FORBIDDEN_EDITOR.test(n))).toEqual([]);
  });

  it("has no node-pty or other native packages, and no native optionalDependencies (F9)", () => {
    expect(names.filter((n) => FORBIDDEN_NATIVE.test(n))).toEqual([]);
    expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([]);
  });

  it("has no analytics, telemetry or tracking package (F5)", () => {
    expect(names.filter((n) => FORBIDDEN_TRACKING.test(n))).toEqual([]);
  });

  it("ships no runtime dependency with binding.gyp, gypfile or a .node binary (F9)", () => {
    const native = runtimeClosure()
      .map((n) => [n, isNativePackage(path.join(REPO_ROOT, "node_modules", n))] as const)
      .filter(([, why]) => why);
    expect(native).toEqual([]);
  });
});

describe("isNativePackage (the scanner the F9 test relies on)", () => {
  it("flags binding.gyp, gypfile and .node files, and passes a plain package", () => {
    const root = tempDir();
    const make = (name: string, files: Record<string, string>) => {
      const d = path.join(root, name);
      fs.mkdirSync(d, { recursive: true });
      for (const [f, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
        fs.writeFileSync(path.join(d, f), c);
      }
      return d;
    };
    expect(isNativePackage(make("gyp", { "binding.gyp": "{}", "package.json": "{}" }))).toBe("binding.gyp");
    expect(isNativePackage(make("flag", { "package.json": '{"gypfile": true}' }))).toBe("gypfile");
    expect(isNativePackage(make("bin", { "package.json": "{}", "build/Release/x.node": "" }))).toBe(".node binary");
    expect(isNativePackage(make("plain", { "package.json": "{}", "index.js": "" }))).toBeNull();
  });
});

describe("source tree (F5)", () => {
  const srcDir = path.join(REPO_ROOT, "src");
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  const sources = files.map((f) => [f, fs.readFileSync(path.join(srcDir, f), "utf8")] as const);

  it("imports no tracking package", () => {
    for (const [f, text] of sources) {
      const imports = [...text.matchAll(/(?:from|require\()\s*["']([^"'./][^"']*)["']/g)].map((m) => m[1]);
      expect(imports.filter((i) => FORBIDDEN_TRACKING.test(i)), f).toEqual([]);
    }
  });

  it("contacts only 127.0.0.1: every URL in src/ is loopback", () => {
    for (const [f, text] of sources) {
      const urls = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
      const external = urls.filter((u) => !/^https?:\/\/(127\.0\.0\.1|\$\{)/.test(u));
      expect(external, f).toEqual([]);
    }
  });

  it("switches VS Code telemetry off wherever it mentions it", () => {
    const server = fs.readFileSync(path.join(srcDir, "server.ts"), "utf8");
    expect(server).toContain('"--disable-telemetry"');
    const settings = fs.readFileSync(path.join(srcDir, "settings.ts"), "utf8");
    expect(settings).toContain('"telemetry.telemetryLevel": "off"');
  });
});

describe("no store submission artefacts (F10)", () => {
  it("has no community-plugins.json, versions.json or release-publishing workflow", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "community-plugins.json"))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, "versions.json"))).toBe(false);
    const wf = path.join(REPO_ROOT, ".github", "workflows");
    if (fs.existsSync(wf)) {
      for (const f of fs.readdirSync(wf)) {
        expect(fs.readFileSync(path.join(wf, f), "utf8"), f).not.toMatch(/gh release|create-release|action-gh-release|softprops/);
      }
    }
  });

  it("README says the plugin is not submitted to the community store", () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/not submitted to the community store/i);
  });
});
