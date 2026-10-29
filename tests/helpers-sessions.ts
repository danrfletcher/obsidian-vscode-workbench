/** A session manager over fake helper processes, shared by the session, kill-confirm and layout tests. */
import { PtySession } from "../src/terminal/pty-session";
import type { PreflightResult } from "../src/terminal/pty-preflight";
import { SessionManager, type SessionEvent } from "../src/terminal/session-manager";
import { ShellStartDir } from "../src/terminal/shell-cwd";
import { ShellController } from "../src/terminal/terminal-controller";
import { fakeWorld } from "./fake-pty";

export const GOOD: PreflightResult = { ok: true, python: "/usr/bin/python3", shell: "/bin/zsh" };
export const tick = () => new Promise((r) => setTimeout(r, 5));

export function managerRig(preflight: (n: number) => Promise<PreflightResult> = async () => GOOD) {
  const world = fakeWorld();
  let preflights = 0;
  const manager = new SessionManager({
    shellName: () => "zsh",
    createController: () =>
      new ShellController({
        shell: () => "/bin/zsh",
        preflight: async () => preflight(++preflights),
        installHelper: () => "/vault/.server/pty_helper.py",
        startDir: new ShellStartDir(() => "/vault", () => null, { isDirectory: () => true }),
        size: () => ({ cols: 80, rows: 24 }),
        env: () => ({ TERM: "xterm-256color" }),
        createSession: (o) => new PtySession(o, world.deps),
      }),
  });
  const events: SessionEvent[] = [];
  manager.onEvent((e) => events.push(e));
  return { world, manager, events, of: (type: SessionEvent["type"]) => events.filter((e) => e.type === type) };
}
