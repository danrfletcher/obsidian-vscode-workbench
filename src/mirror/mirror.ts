/**
 * The mirror's read, once per server start (PR-4, G1, G14, E1): which extensions desktop VS Code has switched
 * off, as one answer the server start records before it shares any extension and settings can show.
 *
 *   read      the three lists were read; a snapshot of them is written for later.
 *   snapshot  the read failed; the last good snapshot for this instance, profile and vault is used.
 *   none      the read failed and there is no usable snapshot: no extensions are shared (the next PR reads this).
 *
 * Never throws. The only things it writes are the temp copy (removed again) and `mirror-snapshot.json`, both in
 * the plugin's own folders.
 */
import * as path from "node:path";
import { readDisabledLists, type ReadDeps } from "./disabled-lists";
import { realMirrorFs } from "./mirror-fs";
import { readSnapshot, writeSnapshot, SNAPSHOT_VERSION } from "./snapshot";

/** What the server start needs to know about the instance and profile it is mirroring. */
export type MirrorRequest =
  | {
      /** Stable id of the VS Code install (`Instance.id`). */
      instanceId: string;
      userDataRoot: string;
      vaultPath: string;
      profile: { location: string; isDefault: boolean; dir: string };
    }
  /** The instance or profile could not be worked out, so nothing can be read. */
  | { unavailable: string };

export type MirrorResult =
  | {
      source: "read";
      /** Lower case, sorted. */
      disabled: string[];
      counts: { global: number; profile: number | null; workspace: number };
      notes: string[];
      at: number;
    }
  | { source: "snapshot"; disabled: string[]; takenAt: number; why: string }
  | { source: "none"; disabled: []; why: string };

export interface MirrorOptions {
  /** The plugin's server data dir: the snapshot lives here. */
  dataDir: string;
  /** Where temp copies are made (inside the plugin's own folder). */
  tmpRoot: string;
  signal?: AbortSignal;
  deps?: ReadDeps & { now?: () => number };
}

/** The temp root for a runtime dir. */
export const mirrorTmpRoot = (runtimeDir: string) => path.join(runtimeDir, "mirror-tmp");

export async function mirrorDisabled(request: MirrorRequest, opts: MirrorOptions): Promise<MirrorResult> {
  try {
    return await run(request, opts);
  } catch {
    return { source: "none", disabled: [], why: "the read failed unexpectedly" };
  }
}

async function run(request: MirrorRequest, opts: MirrorOptions): Promise<MirrorResult> {
  if ("unavailable" in request) {
    return { source: "none", disabled: [], why: `desktop VS Code's state cannot be located (${request.unavailable})` };
  }
  const io = opts.deps?.fs ?? realMirrorFs;
  const now = opts.deps?.now ?? Date.now;
  const read = await readDisabledLists(
    { userDataRoot: request.userDataRoot, vaultPath: request.vaultPath, profile: request.profile, tmpRoot: opts.tmpRoot, signal: opts.signal },
    opts.deps,
  );

  if (read.ok) {
    const notes = [...read.notes];
    const at = now();
    try {
      await writeSnapshot(
        opts.dataDir,
        {
          version: SNAPSHOT_VERSION,
          instanceId: request.instanceId,
          profileLocation: request.profile.location,
          vaultPath: request.vaultPath,
          takenAt: at,
          disabled: read.disabled,
        },
        io,
      );
    } catch {
      notes.push("the snapshot for the next start could not be saved");
    }
    return {
      source: "read",
      disabled: read.disabled,
      counts: { global: read.lists.global.length, profile: read.lists.profile ? read.lists.profile.length : null, workspace: read.lists.workspace.length },
      notes,
      at,
    };
  }

  const failure = `the disabled list could not be read (${read.reason})`;
  if (read.kind === "cancelled") return { source: "none", disabled: [], why: failure };
  const snap = await readSnapshot(opts.dataDir, { instanceId: request.instanceId, profileLocation: request.profile.location, vaultPath: request.vaultPath }, io);
  if (snap.status === "found") return { source: "snapshot", disabled: [...snap.snapshot.disabled], takenAt: snap.snapshot.takenAt, why: failure };
  return { source: "none", disabled: [], why: `${failure}; ${snap.why}` };
}
