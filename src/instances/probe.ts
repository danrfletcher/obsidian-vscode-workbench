/**
 * The serve-web probe (G15): does this CLI answer `<cli> serve-web --help`?
 *
 * The probe only asks for help text. It starts no server, opens no port, makes
 * no network call and so downloads nothing (the licence is the server start's
 * gate, PR-2). The CLI is run with `execFile` and an argument array, never
 * through a shell, so a path with spaces or `; $( )` is just a path.
 */
import { execFile, type ExecFileOptions } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** A CLI that has not answered by now counts as failed. */
export const PROBE_TIMEOUT_MS = 5000;

export type ProbeResult = { ok: true } | { ok: false; reason: string };

/** Interpret the end of a `serve-web --help` run: exit 0 and the output mentions serve-web. */
export function judgeProbe(exitCode: number | null, output: string): ProbeResult {
  if (exitCode !== 0) return { ok: false, reason: `\`serve-web --help\` exited with code ${exitCode ?? "none"}.` };
  if (!/serve-web/i.test(output)) return { ok: false, reason: "this build has no \"serve-web\" command." };
  return { ok: true };
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL"); // the child leads its own group, so a script's own children go too
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run `<cli> serve-web --help` once. Never rejects. A probe that has not
 * finished after `timeoutMs` is killed (with everything it started) and counts
 * as failed; the answer does not wait for the child's pipes to close.
 */
export function probeServeWeb(cli: string, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        cli,
        ["serve-web", "--help"],
        // `detached` makes the child lead its own process group (execFile passes it on to spawn), so a timeout can kill the group.
        { detached: true, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" } as ExecFileOptions,
        (err, stdout, stderr) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (typeof code === "number") return finish(judgeProbe(code, `${String(stdout)}\n${String(stderr)}`));
            if (code === "ENOENT") return finish({ ok: false, reason: "the program (or a helper it needs) was not found (ENOENT)." });
            if (code === "EACCES") return finish({ ok: false, reason: "the program is not allowed to run (EACCES)." });
            return finish({ ok: false, reason: `could not run it (${typeof code === "string" ? code : "error"}).` });
          }
          finish(judgeProbe(0, `${String(stdout)}\n${String(stderr)}`));
        },
      );
    } catch (e) {
      return finish({ ok: false, reason: `could not run it (${(e as NodeJS.ErrnoException).code ?? "error"}).` });
    }
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(); // a CLI that reads stdin sees the end at once
    timer = setTimeout(() => {
      killGroup(child.pid);
      finish({ ok: false, reason: `no answer within ${Math.round(timeoutMs / 1000)} s (killed).` });
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
}

export type CliCheck = { ok: true; cli: string } | { ok: false; reason: string };

/**
 * Check a CLI path typed by the user: an absolute path to an executable file
 * that passes the same probe. The reason of a failure is one plain sentence
 * for the settings tab.
 */
export async function verifyCliPath(input: string, opts: { timeoutMs?: number } = {}): Promise<CliCheck> {
  const cli = input.trim();
  if (cli === "") return { ok: false, reason: "Enter the path of a VS Code command-line tool." };
  if (cli.includes("\0")) return { ok: false, reason: "That path is not valid." };
  if (!path.isAbsolute(cli)) return { ok: false, reason: "Use an absolute path (starting with /)." };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cli);
  } catch {
    return { ok: false, reason: "No file exists at that path." };
  }
  if (stat.isDirectory()) return { ok: false, reason: "That path is a folder; enter the command-line tool inside it." };
  try {
    fs.accessSync(cli, fs.constants.X_OK);
  } catch {
    return { ok: false, reason: "That file is not executable." };
  }
  const probe = await probeServeWeb(cli, opts);
  if (!probe.ok) return { ok: false, reason: `That program cannot run serve-web: ${probe.reason}` };
  return { ok: true, cli };
}
