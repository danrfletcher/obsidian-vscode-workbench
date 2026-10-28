import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { buildExtensionList, type ListFs } from "../../src/settings/extension-list";
import type { ExtensionListView, ExtensionRow } from "../../src/settings/extension-states";
import { IDS, extensionsJsonText, logText, makeTree, runningInput } from "../fixtures/extensions-section/tree";

const rowsOf = (view: ExtensionListView): ExtensionRow[] => {
  expect(view.status).toBe("listed");
  return view.status === "listed" ? view.rows : [];
};
const byId = (rows: ExtensionRow[], id: string): ExtensionRow => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row for ${id}: ${rows.map((x) => x.id).join(", ")}`);
  return r;
};

describe("buildExtensionList: the five states from a real tree (links made by shareExtensions, a real log on disk)", () => {
  it("one extension in each state, each with a reason: disabled, untrusted, failed, active, inactive", async () => {
    // pylance fails, python and turbo activate, gitlens is disabled in VS Code, the rest are quiet
    const tree = makeTree({ disabled: [IDS.gitlens], logs: { exthost1: logText("failing") + logText("healthy").split("\n").filter((l) => l.includes("ms-python.python")).join("\n") + "\n" } });
    const rows = rowsOf(await buildExtensionList(runningInput(tree)));
    expect(rows).toHaveLength(8);
    expect(byId(rows, IDS.gitlens).state).toBe("disabled");
    expect(byId(rows, IDS.gitlens).stateLabel).toBe("disabled in VS Code");
    expect(byId(rows, IDS.pylance).state).toBe("failed");
    expect(byId(rows, IDS.pylance).reason).toBe("Error: Pylance can only be used with Microsoft's own builds of VS Code.");
    expect(byId(rows, IDS.turbo).state).toBe("active");
    expect(byId(rows, IDS.python).state).toBe("active");
    expect(byId(rows, IDS.yaml).state).toBe("inactive");
    for (const r of rows) {
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.reason).not.toMatch(/[\r\n]/);
    }
    // untrusted: the trust seed was on and did not seed
    const untrusted = rowsOf(await buildExtensionList(runningInput(tree, { trustOutcome: "no-trust-record" })));
    expect(byId(untrusted, IDS.turbo).state).toBe("untrusted");
    expect(byId(untrusted, IDS.gitlens).state).toBe("disabled"); // disabled still outranks untrusted
  });

  it("name, id and version come from the profile and the extension's own package.json (including a %key% display name)", async () => {
    const tree = makeTree();
    const rows = rowsOf(await buildExtensionList(runningInput(tree)));
    const turbo = byId(rows, IDS.turbo);
    expect(turbo).toMatchObject({ name: "Turbo Console Log", id: "ChakrounAnas.turbo-console-log", version: "3.2.1" });
    expect(byId(rows, IDS.yaml).name).toBe("YAML");
    expect(byId(rows, IDS.gitlens).name).toBe("GitLens — Git supercharged");
  });

  it("rows are sorted by name, case-insensitively", async () => {
    const rows = rowsOf(await buildExtensionList(runningInput(makeTree())));
    const names = rows.map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });

  it("no publisher is treated differently (F6): Microsoft-published extensions get the same states and wording as the others", async () => {
    const msOnly = (id: string) => id.toLowerCase().startsWith("ms-");
    const logQuiet = { exthost1: "2026-10-28 09:00:01.000 [info] Extension host started\n" };
    const rows = rowsOf(await buildExtensionList(runningInput(makeTree({ logs: logQuiet }))));
    const ms = rows.filter((r) => msOnly(r.id));
    const other = rows.filter((r) => !msOnly(r.id));
    expect(ms.length).toBe(3);
    expect(new Set([...ms, ...other].map((r) => `${r.state}|${r.reason}`))).toEqual(new Set(["inactive|not activated yet; most extensions start when a file they handle is opened in the tab"]));
    // and a failure reads the same for both publishers
    const failing = rowsOf(
      await buildExtensionList(
        runningInput(
          makeTree({
            logs: { exthost1: "2026-10-28 09:00:01.000 [error] ms-python.python crashed\n2026-10-28 09:00:02.000 [error] esbenp.prettier-vscode crashed\n" },
          }),
        ),
      ),
    );
    expect(byId(failing, IDS.python).state).toBe(byId(failing, IDS.prettier).state);
    expect(byId(failing, IDS.python).state).toBe("failed");
  });

  it("no extension host log: every extension is inactive and says so (not failed, not active)", async () => {
    const rows = rowsOf(await buildExtensionList(runningInput(makeTree())));
    expect(new Set(rows.map((r) => r.state))).toEqual(new Set(["inactive"]));
    expect(new Set(rows.map((r) => r.reason))).toEqual(new Set(["no extension host log found"]));
  });

  it("an empty log is the same as no log", async () => {
    const rows = rowsOf(await buildExtensionList(runningInput(makeTree({ logs: { exthost1: logText("empty") } }))));
    expect(rows.every((r) => r.state === "inactive" && r.reason === "no extension host log found")).toBe(true);
  });

  it("a switched-off extension is listed from the instance's folder even though it is not linked into the server's extensions", async () => {
    const tree = makeTree({ disabled: [IDS.eslint] });
    const linked = fs.readdirSync(path.join(tree.serverDataDir, "extensions"));
    expect(linked.some((n) => n.toLowerCase().startsWith("dbaeumer.vscode-eslint"))).toBe(false);
    const row = byId(rowsOf(await buildExtensionList(runningInput(tree))), IDS.eslint);
    expect(row).toMatchObject({ state: "disabled", name: "ESLint", version: "3.0.10" });
  });

  it("disabled ids match case-insensitively (the lists are lower-cased, the profile keeps the publisher's case)", async () => {
    const tree = makeTree({ disabled: ["chakrounanas.turbo-console-log"] });
    expect(byId(rowsOf(await buildExtensionList(runningInput(tree))), IDS.turbo).state).toBe("disabled");
  });

  it("the trust outcome only makes rows untrusted when the trust setting is on and the seed did not succeed", async () => {
    const tree = makeTree();
    const state = async (over: Parameters<typeof runningInput>[1]) => byId(rowsOf(await buildExtensionList(runningInput(tree, over))), IDS.turbo).state;
    expect(await state({ trustSeedOn: true, trustOutcome: "seeded" })).toBe("inactive");
    expect(await state({ trustSeedOn: true, trustOutcome: null })).toBe("inactive"); // no tab has run the seed yet: nothing known
    expect(await state({ trustSeedOn: true, trustOutcome: "no-trust-record" })).toBe("untrusted");
    expect(await state({ trustSeedOn: false, trustOutcome: "no-trust-record" })).toBe("inactive"); // the user turned the seed off: not this list's call
  });

  it("an extension whose folder is gone, or whose link dangles, is left out and the others still list (E5)", async () => {
    const tree = makeTree();
    const ext = path.join(tree.serverDataDir, "extensions");
    const link = fs.readdirSync(ext).find((n) => n.toLowerCase().startsWith("ms-python.python-"))!;
    const target = fs.realpathSync(path.join(ext, link));
    fs.rmSync(target, { recursive: true });
    const rows = rowsOf(await buildExtensionList(runningInput(tree)));
    expect(rows.some((r) => r.id === IDS.python)).toBe(false);
    expect(rows).toHaveLength(7);
  });

  it("a missing or broken package.json falls back to the id and the profile's version, never to a failure", async () => {
    const tree = makeTree();
    const ext = path.join(tree.serverDataDir, "extensions");
    const dir = (id: string) => path.join(ext, fs.readdirSync(ext).find((n) => n.toLowerCase().startsWith(`${id.toLowerCase()}-`))!);
    fs.rmSync(path.join(dir(IDS.prettier), "package.json"));
    fs.writeFileSync(path.join(dir(IDS.eslint), "package.json"), "{ not json");
    const rows = rowsOf(await buildExtensionList(runningInput(tree)));
    expect(byId(rows, IDS.prettier)).toMatchObject({ name: "prettier-vscode", version: "11.0.0" });
    expect(byId(rows, IDS.eslint)).toMatchObject({ name: "vscode-eslint", version: "3.0.10" });
  });

  it("markup and control characters in a package.json name are cleaned and capped (shown only as text)", async () => {
    const tree = makeTree();
    const ext = path.join(tree.serverDataDir, "extensions");
    const d = path.join(ext, fs.readdirSync(ext).find((n) => n.toLowerCase().startsWith("eamodio.gitlens-"))!);
    fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ displayName: `<img src=x onerror=1>\u202e\n${"n".repeat(300)}` }));
    const row = byId(rowsOf(await buildExtensionList(runningInput(tree))), IDS.gitlens);
    expect(row.name.startsWith("<img src=x onerror=1> n")).toBe(true);
    expect(Array.from(row.name).length).toBe(80);
    expect(row.name).not.toMatch(/[\n\u202e]/);
  });
});

describe("buildExtensionList: the cases with no list", () => {
  it("server not running: server-not-running, and nothing from an earlier run's log is read", async () => {
    const tree = makeTree({ logs: { exthost1: logText("failing") } });
    let asked = false;
    const view = await buildExtensionList(runningInput(tree, { serverRunning: false }), {
      readLog: async () => {
        asked = true;
        return { found: false };
      },
    });
    expect(view).toEqual({ status: "server-not-running" });
    expect(asked).toBe(false);
    expect(await buildExtensionList(runningInput(tree, { serverDataDir: null }))).toEqual({ status: "server-not-running" });
  });

  it("no start has read the profile yet: an empty list that says why", async () => {
    const view = await buildExtensionList(runningInput(makeTree(), { mirror: null }));
    expect(view).toEqual({ status: "empty", message: "No extensions shared", reason: "nothing was read from desktop VS Code at the last server start" });
  });

  it("the disabled lists could not be read (source none): no list, with the reason the read gave", async () => {
    const tree = makeTree();
    const mirror = { ...tree.mirror, disabled: { source: "none", disabled: [], counts: { global: 0, profile: null, workspace: 0 }, notes: [], at: 1, why: "no readable state.vscdb" } as never };
    const view = await buildExtensionList(runningInput(tree, { mirror }));
    expect(view.status).toBe("empty");
  });

  it("the profile's extension list was unreadable: the empty list carries the reason", async () => {
    const tree = makeTree();
    const mirror = { ...tree.mirror, extensions: { ok: false as const, why: "extensions.json is not valid JSON" } };
    expect(await buildExtensionList(runningInput(tree, { mirror }))).toEqual({ status: "empty", message: "No extensions shared", reason: "extensions.json is not valid JSON" });
  });

  it("the profile lists no extensions: an empty list", async () => {
    const tree = makeTree({ extensionsJson: "[]" });
    expect(await buildExtensionList(runningInput(tree))).toEqual({ status: "empty", message: "No extensions shared", reason: "the profile lists no extensions" });
  });

  it("every folder is gone: an empty list that says so", async () => {
    const tree = makeTree();
    fs.rmSync(path.join(tree.serverDataDir, "extensions"), { recursive: true });
    const view = await buildExtensionList(runningInput(tree));
    expect(view).toEqual({ status: "empty", message: "No extensions shared", reason: "none of the profile's extension folders could be found" });
  });

  it("never throws: a file system or log reader that throws gives an empty list", async () => {
    const tree = makeTree();
    const boom: ListFs = {
      isDirectory: async () => {
        throw new Error("EIO");
      },
      readJson: async () => {
        throw new Error("EIO");
      },
    };
    expect((await buildExtensionList(runningInput(tree), { fs: boom })).status).toBe("empty");
    const view = await buildExtensionList(runningInput(tree), {
      readLog: async () => {
        throw new Error("boom");
      },
    });
    expect(view.status).toBe("empty");
  });
});

describe("buildExtensionList: it only reads (F1, F7)", () => {
  const snapshot = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const st = fs.lstatSync(p);
        out.push(`${path.relative(dir, p)}|${e.isSymbolicLink() ? fs.readlinkSync(p) : st.size}|${st.mtimeMs}`);
        if (e.isDirectory()) walk(p);
      }
    };
    walk(dir);
    return out.sort();
  };

  it("changes nothing under the tree, and a second call gives the same answer", async () => {
    const tree = makeTree({ disabled: [IDS.gitlens], logs: { exthost1: logText("failing") } });
    const before = snapshot(tree.root);
    const a = await buildExtensionList(runningInput(tree));
    const b = await buildExtensionList(runningInput(tree));
    expect(b).toEqual(a);
    expect(snapshot(tree.root)).toEqual(before);
    expect(extensionsJsonText().length).toBeGreaterThan(0);
  });

  it("reads again each call: a log written after the first call shows in the second (nothing is cached)", async () => {
    const tree = makeTree();
    const first = rowsOf(await buildExtensionList(runningInput(tree)));
    expect(byId(first, IDS.python).state).toBe("inactive");
    tree.writeLog("20261028T090000", "exthost1", logText("healthy"));
    const second = rowsOf(await buildExtensionList(runningInput(tree)));
    expect(byId(second, IDS.python).state).toBe("active");
  });

  it("the disabled-list read is the one the host gave: a snapshot read lists the same disabled ids", async () => {
    const tree = makeTree();
    const mirror = { ...tree.mirror, disabled: { source: "snapshot" as const, disabled: [IDS.gitlens.toLowerCase()], takenAt: 1, why: "desktop VS Code's state was locked; the last good copy was used" } };
    expect(byId(rowsOf(await buildExtensionList(runningInput(tree, { mirror }))), IDS.gitlens).state).toBe("disabled");
  });
});
