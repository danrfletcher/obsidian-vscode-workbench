/**
 * The flow's one decision that is not about the folder: which click made the terminal page, because only that click's request
 * asks the extension to take the place of the page's own first terminal (G2, R1). The folder rules are in
 * terminal-folder-target.test.ts; the whole flow against a page that makes its own first terminal is in
 * tests/integration/new-terminal-at-folder.test.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { newTerminalAtFolder, type NewTerminalDeps } from "../../src/terminal-host/new-terminal";
import { REQUESTS_DIR, extensionDir, installTerminalAtExtension } from "../../src/terminal-host/terminal-at-extension";
import { tempDir } from "../helpers";

let data: string;
beforeEach(() => {
  data = tempDir();
  installTerminalAtExtension(data);
});

const requests = () => fs.readdirSync(path.join(extensionDir(data), REQUESTS_DIR)).sort().map((f) => JSON.parse(fs.readFileSync(path.join(extensionDir(data), REQUESTS_DIR, f), "utf8")) as Record<string, unknown>);

/** A host page whose state the test sets: what it is before the click, and what `reveal` does to it. */
function deps(before: { ready: boolean; starting: boolean }, afterReveal: { ready: boolean; starting: boolean }): NewTerminalDeps {
  let state = before;
  return {
    vaultRoot: () => "/vault",
    reveal: () => void (state = afterReveal),
    settled: async () => {
      state = { ready: true, starting: false };
    },
    ready: () => state.ready,
    starting: () => state.starting,
    focusTerminal: () => undefined,
    serverDataDir: () => data,
    unloaded: () => false,
    notice: () => undefined,
  };
}

describe("adoptFirst: only the click that made the page asks to take the place of the page's own first terminal", () => {
  it("the page was not there and this click's reveal started it: the request says so", async () => {
    await newTerminalAtFolder(deps({ ready: false, starting: false }, { ready: false, starting: true }), "");
    expect(requests().map((r) => r.adoptFirst)).toEqual([true]);
  });

  it("the page is already starting for an earlier click: the request does not", async () => {
    await newTerminalAtFolder(deps({ ready: false, starting: true }, { ready: false, starting: true }), "");
    expect(requests().map((r) => "adoptFirst" in r)).toEqual([false]);
  });

  it("the page is already up: the request does not", async () => {
    await newTerminalAtFolder(deps({ ready: true, starting: false }, { ready: true, starting: false }), "");
    expect(requests().map((r) => "adoptFirst" in r)).toEqual([false]);
  });

  it("the reveal did not start a page (nothing to wait for): the request does not", async () => {
    await newTerminalAtFolder(deps({ ready: false, starting: false }, { ready: false, starting: false }), "");
    expect(requests().map((r) => "adoptFirst" in r)).toEqual([false]);
  });
});
