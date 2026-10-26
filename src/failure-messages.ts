/**
 * What the user is told when the server cannot start. One place, so the wording
 * is the same everywhere and can be tested as a table.
 *
 * Nothing here ever includes the connection token: the log tail it quotes (the
 * child's stdout and stderr) has already been through redactToken in server.ts,
 * and it is redacted again.
 */
import { redactToken, ServerStartError } from "./server";

export type FailureKind =
  | "missing-binary"
  | "no-serve-web"
  | "port-bind"
  | "offline-first-run"
  | "offline-redownload"
  | "download"
  | "exit"
  | "timeout"
  | "spawn";

/** What is known about the last server build that ran, to tell a first run from a re-download. */
export interface FailureContext {
  /** Version of the installed VS Code build, e.g. "1.144.0". */
  installedVersion?: string;
  installedCommit?: string | null;
  /** The last server build that started successfully. */
  lastServer?: { commit: string; version: string } | null;
  /** Whether that build's files are still in the plugin's server cache. */
  lastServerCached?: boolean;
}

export interface StartFailure {
  kind: FailureKind;
  /** The full Notice text. */
  message: string;
  /** Set for an offline re-download after a VS Code update: the build that can be reused. */
  offerReuse?: { commit: string; version: string };
  /** The version change in words, for the reuse prompt. */
  versionChange?: { from: string; to: string };
}

export const NOTICE_PREFIX = "VS Code Workbench: ";

const OFFLINE_RE =
  /network is unreachable|network unreachable|dns error|failed to lookup address|name or service not known|nodename nor servname|temporary failure in name resolution|enotfound|enetunreach|eai_again|no route to host|ehostunreach|error trying to connect/i;
const PORT_RE = /address already in use|address in use|eaddrinuse|os error 48|os error 98|could not bind|failed to bind|cannot bind|only one usage of each socket/i;

export function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function withLast(sentence: string, tail: string): string {
  const last = lastLine(tail);
  return last ? `${sentence} Last message: ${last}` : sentence;
}

/** Map a start error to the Notice text (and, for an offline re-download, the reuse offer). */
export function describeFailure(err: unknown, ctx: FailureContext = {}): StartFailure {
  if (!(err instanceof ServerStartError)) {
    const text = err instanceof Error ? err.message : String(err);
    return { kind: "spawn", message: `${NOTICE_PREFIX}${redactToken(text, null)}` };
  }
  const tail = redactToken(err.stderrTail, null);
  const done = (f: StartFailure): StartFailure => ({ ...f, message: redactToken(f.message, null) });

  switch (err.kind) {
    case "missing-binary":
      return done({ kind: "missing-binary", message: `${NOTICE_PREFIX}VS Code was not found. Install Visual Studio Code, then open a Code tab again.` });
    case "no-serve-web":
      return done({
        kind: "no-serve-web",
        message: `${NOTICE_PREFIX}${err.detail ?? "This VS Code build"} has no "serve-web" command. Update Visual Studio Code to a version that includes it.`,
      });
    case "spawn":
      if (/ENOENT|EACCES/.test(err.message)) {
        return done({ kind: "missing-binary", message: `${NOTICE_PREFIX}VS Code was not found. Install Visual Studio Code, then open a Code tab again.` });
      }
      return done({ kind: "spawn", message: `${NOTICE_PREFIX}${err.message}` });
    default:
      break;
  }

  if (OFFLINE_RE.test(tail)) {
    const last = ctx.lastServer;
    const changed = !!last && !!ctx.installedCommit && last.commit !== ctx.installedCommit && ctx.lastServerCached === true;
    if (changed && last) {
      const to = ctx.installedVersion ?? "the new version";
      return done({
        kind: "offline-redownload",
        message:
          `${NOTICE_PREFIX}VS Code was updated from ${last.version} to ${to}, and the matching VS Code server cannot be downloaded because the network is unreachable. ` +
          `The server downloaded for ${last.version} is still available.`,
        offerReuse: { commit: last.commit, version: last.version },
        versionChange: { from: last.version, to },
      });
    }
    return done({
      kind: "offline-first-run",
      message: `${NOTICE_PREFIX}The VS Code server could not be downloaded because the network is unreachable. Connect to the internet and open a Code tab again. Your licence acceptance is kept.`,
    });
  }
  if (PORT_RE.test(tail)) {
    const where = err.port ? `127.0.0.1:${err.port}` : "its port on 127.0.0.1";
    return done({
      kind: "port-bind",
      message: withLast(
        `${NOTICE_PREFIX}The VS Code server could not listen on ${where}${err.exitCode !== null ? ` (exit code ${err.exitCode})` : ""}. Use "Restart server" in the plugin settings to try another port.`,
        tail,
      ),
    });
  }
  if (err.kind === "download") {
    return done({
      kind: "download",
      message: withLast(
        `${NOTICE_PREFIX}The VS Code server could not be downloaded. Try again later, or use "Restart server" in the plugin settings. Your licence acceptance is kept.`,
        tail,
      ),
    });
  }
  if (err.kind === "timeout") {
    return done({ kind: "timeout", message: withLast(`${NOTICE_PREFIX}The VS Code server was not ready after ${err.seconds ?? "?"} s.`, tail) });
  }
  const how = err.exitCode !== null ? `exited with code ${err.exitCode}` : "was stopped before it was ready";
  return done({ kind: "exit", message: withLast(`${NOTICE_PREFIX}The VS Code server ${how}.`, tail) });
}
