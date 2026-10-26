import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { compareVersions, findNewestBuild, parseVersion, rewriteExtensionsJson, shareExtensions } from "../../src/server";
import { tempDir } from "../helpers";

function fakeInstall(root: string, name: string, version: string, dataFolderName: string, commit?: string): string {
  const cli = path.join(root, name, "Contents/Resources/app/bin/code");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, name, "Contents/Resources/app/product.json"), JSON.stringify({ version, dataFolderName, commit }));
  return cli;
}

describe("versions", () => {
  it("parses and compares numerically, not as strings", () => {
    expect(parseVersion("1.144.0-insider")).toEqual([1, 144, 0]);
    expect(parseVersion("garbage")).toEqual([0, 0, 0]);
    expect(compareVersions(parseVersion("1.100.0"), parseVersion("1.99.9"))).toBeGreaterThan(0);
    expect(compareVersions(parseVersion("1.2.3"), parseVersion("1.2.3"))).toBe(0);
  });
});

describe("findNewestBuild", () => {
  it("picks the highest version among the installed candidates", () => {
    const root = tempDir();
    const home = tempDir();
    const old = fakeInstall(root, "Old.app", "1.99.0", ".vscode");
    const newer = fakeInstall(root, "New.app", "1.144.0-insider", ".vscode-insiders");
    const build = findNewestBuild({ home, candidates: [old, path.join(root, "Missing.app/code"), newer] });
    expect(build?.versionText).toBe("1.144.0-insider");
    expect(build?.cli).toBe(fs.realpathSync(newer));
    expect(build?.extensionsDir).toBe(path.join(home, ".vscode-insiders", "extensions"));
  });

  it("reads the build's commit from product.json, only when it is a 40-hex sha", () => {
    const root = tempDir();
    const sha = "a57ca762e62475ed8fc64b5aec67485c06766141";
    expect(findNewestBuild({ home: tempDir(), candidates: [fakeInstall(root, "A.app", "1.1.0", ".vscode", sha)] })?.commit).toBe(sha);
    expect(findNewestBuild({ home: tempDir(), candidates: [fakeInstall(root, "B.app", "1.1.0", ".vscode", "not-a-sha")] })?.commit).toBeNull();
    expect(findNewestBuild({ home: tempDir(), candidates: [fakeInstall(root, "C.app", "1.1.0", ".vscode")] })?.commit).toBeNull();
  });

  it("returns null when nothing is installed", () => {
    expect(findNewestBuild({ home: tempDir(), candidates: ["/nonexistent/a", "/nonexistent/b"] })).toBeNull();
  });

  it("honours an explicit codeCliPath override", () => {
    const root = tempDir();
    const cli = fakeInstall(root, "Mine.app", "1.50.0", ".vscode");
    const other = fakeInstall(root, "Other.app", "1.200.0", ".vscode");
    expect(findNewestBuild({ override: cli, home: tempDir(), candidates: [other] })?.versionText).toBe("1.50.0");
    expect(findNewestBuild({ override: "/nonexistent/code" })).toBeNull();
  });
});

describe("shareExtensions (F3: the instance's folder is only read)", () => {
  function instanceExtensions(): string {
    const dir = path.join(tempDir(), "extensions");
    fs.mkdirSync(path.join(dir, "ms-python.python-1.0"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ms-python.python-1.0", "package.json"), "{}");
    fs.mkdirSync(path.join(dir, "ms-python.vscode-pylance-2.0"), { recursive: true });
    fs.writeFileSync(path.join(dir, "extensions.json"), '[{"id":"ms-python.python"}]');
    fs.writeFileSync(path.join(dir, ".obsolete"), "{}");
    return dir;
  }

  it("symlinks each extension dir, copies extensions.json and skips dotfiles", () => {
    const src = instanceExtensions();
    const data = tempDir();
    expect(shareExtensions(src, data)).toEqual({ linked: 2 });
    const t = path.join(data, "extensions");
    expect(fs.lstatSync(path.join(t, "ms-python.python-1.0")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(t, "ms-python.python-1.0", "package.json"), "utf8")).toBe("{}");
    expect(fs.lstatSync(path.join(t, "extensions.json")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(t, ".obsolete"))).toBe(false);
  });

  it("changes nothing in the instance's folder", () => {
    const src = instanceExtensions();
    const before = fs.readdirSync(src).sort();
    const json = fs.readFileSync(path.join(src, "extensions.json"), "utf8");
    shareExtensions(src, tempDir());
    // editing the copy must not reach the original
    expect(fs.readdirSync(src).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(src, "extensions.json"), "utf8")).toBe(json);
  });

  it("drops links to extensions that were removed since the last run", () => {
    const src = instanceExtensions();
    const data = tempDir();
    shareExtensions(src, data);
    fs.rmSync(path.join(src, "ms-python.vscode-pylance-2.0"), { recursive: true });
    shareExtensions(src, data);
    expect(fs.readdirSync(path.join(data, "extensions")).sort()).toEqual(["extensions.json", "ms-python.python-1.0"]);
  });

  it("creates an empty extensions dir when the instance has none", () => {
    const data = tempDir();
    expect(shareExtensions(null, data)).toEqual({ linked: 0 });
    expect(fs.existsSync(path.join(data, "extensions"))).toBe(true);
  });
});

/** An entry in the shape VS Code writes (copied from a real ~/.vscode-insiders/extensions/extensions.json). */
function realEntry(dir: string, id: string, version: string): Record<string, unknown> {
  const folder = `${id}-${version}`;
  return {
    identifier: { id, uuid: "0479fc1c-3d67-49f9-b087-fb9069afe48f" },
    version,
    location: { $mid: 1, path: path.join(dir, folder), scheme: "file" },
    relativeLocation: folder,
    metadata: { installedTimestamp: 1772655254049, pinned: false, source: "gallery", updated: false, private: false },
  };
}

describe("extensions.json holds no path into the instance's folder (F3)", () => {
  function realInstance(): { src: string; names: string[] } {
    const src = path.join(tempDir(), ".vscode-insiders", "extensions");
    const names = ["ms-python.python-2026.10.0-darwin-arm64", "ms-python.vscode-pylance-2026.4.101"];
    for (const n of names) {
      fs.mkdirSync(path.join(src, n), { recursive: true });
      fs.writeFileSync(path.join(src, n, "package.json"), "{}");
    }
    fs.writeFileSync(
      path.join(src, "extensions.json"),
      JSON.stringify([realEntry(src, "ms-python.python", "2026.10.0-darwin-arm64"), realEntry(src, "ms-python.vscode-pylance", "2026.4.101")]),
    );
    return { src, names };
  }

  it("rewrites every location to the symlink under the server data dir; nothing under sourceDir remains", () => {
    const { src, names } = realInstance();
    const data = tempDir();
    shareExtensions(src, data);
    const target = path.join(data, "extensions");
    const raw = fs.readFileSync(path.join(target, "extensions.json"), "utf8");
    expect(raw).not.toContain(src);
    expect(raw).not.toContain(".vscode-insiders");
    const entries = JSON.parse(raw) as { location: { path: string; scheme: string; $mid: number }; relativeLocation: string }[];
    expect(entries.map((e) => e.location.path)).toEqual(names.map((n) => path.join(target, n)));
    expect(entries.map((e) => e.relativeLocation)).toEqual(names);
    expect(entries[0].location.scheme).toBe("file");
    // each rewritten location is the symlink, which resolves to the instance's folder (read-only use)
    for (const e of entries) expect(fs.lstatSync(e.location.path).isSymbolicLink()).toBe(true);
  });

  it("keeps the other fields of an entry unchanged", () => {
    const { src } = realInstance();
    const before = JSON.parse(fs.readFileSync(path.join(src, "extensions.json"), "utf8")) as Record<string, unknown>[];
    const out = JSON.parse(rewriteExtensionsJson(JSON.stringify(before), "/plugin/server-data/extensions")) as Record<string, unknown>[];
    for (const [i, e] of out.entries()) {
      const { location: _l, ...rest } = e;
      const { location: _b, ...restBefore } = before[i];
      expect(rest).toEqual(restBefore);
    }
  });

  it("derives the folder name from location.path when relativeLocation is missing", () => {
    const e = { identifier: { id: "a.b" }, location: { $mid: 1, path: "/home/x/.vscode/extensions/a.b-1.0.0", scheme: "file" } };
    const out = JSON.parse(rewriteExtensionsJson(JSON.stringify([e]), "/t/extensions")) as { location: { path: string } }[];
    expect(out[0].location.path).toBe("/t/extensions/a.b-1.0.0");
    const asString = JSON.parse(rewriteExtensionsJson(JSON.stringify([{ location: "/home/x/.vscode/extensions/c.d-2.0.0" }]), "/t/extensions")) as { location: string }[];
    expect(asString[0].location).toBe("/t/extensions/c.d-2.0.0");
  });

  it("never passes unparseable or non-array content through: it yields an empty list", () => {
    expect(rewriteExtensionsJson("{ not json /home/x/.vscode/extensions/a-1", "/t")).toBe("[]");
    expect(rewriteExtensionsJson('{"location":"/home/x/.vscode/extensions/a-1"}', "/t")).toBe("[]");
  });

  it("removing an extension through the shared link (uninstall in the embed) leaves the instance's folder intact", () => {
    const { src, names } = realInstance();
    const data = tempDir();
    shareExtensions(src, data);
    const link = path.join(data, "extensions", names[0]);
    fs.rmSync(link, { recursive: true, force: true });
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(src, names[0], "package.json"), "utf8")).toBe("{}");
  });
});
