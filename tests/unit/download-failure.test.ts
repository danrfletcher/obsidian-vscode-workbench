/**
 * Spotting a failed server download from what the real `code serve-web` shows: it logs to stdout,
 * keeps answering 202, and logs "Downloading server" once per attempt. (Checked by hand against
 * VS Code 1.144: a download in progress logged the line once across six requests; a failing one
 * logged it again on every request, with no reason anywhere in the output.)
 */
import { describe, expect, it } from "vitest";
import { downloadFailureSignal, isLogNoise } from "../../src/server";

describe("downloadFailureSignal", () => {
  it.each([
    ["no attempt logged yet", { startLines: 0, errorLine: null, probeBody: "" }, null],
    ["one attempt in progress (a slow download, however many requests arrive)", { startLines: 1, errorLine: null, probeBody: "The latest version of the Visual Studio Code Server is downloading, please wait a moment..." }, null],
    ["a second attempt: the first one failed", { startLines: 2, errorLine: null, probeBody: "" }, "The server download was attempted again after it failed."],
    ["an error-level log line about the download", { startLines: 1, errorLine: "[t] error Error downloading server: boom", probeBody: "" }, "[t] error Error downloading server: boom"],
    ["the failed-download page", { startLines: 1, errorLine: null, probeBody: "An error was encountered downloading the server, please retry: <b>boom</b>" }, "An error was encountered downloading the server, please retry: boom"],
  ])("%s", (_n, input, expected) => {
    expect(downloadFailureSignal(input)).toBe(expected);
  });
});

describe("isLogNoise", () => {
  it.each([
    ["*", true],
    ["* Visual Studio Code Server", true],
    ["Web UI available at http://127.0.0.1:5?tkn=<redacted>", true],
    ["[2026-10-26 11:36:36] info Downloading server abc", false],
    ["fatal: the fake server broke", false],
  ])("%s -> %s", (line, noise) => {
    expect(isLogNoise(line)).toBe(noise);
  });
});
