/**
 * The Mirror snapshot (PR-4, G14): the disabled list as the last successful read of desktop VS Code gave it,
 * kept in the plugin's own server data dir as `mirror-snapshot.json` for the day a read fails.
 *
 * It records the instance id, the profile location and the vault path it was read for. A snapshot for another
 * instance, profile or vault is ignored (it counts as "none"), because a list for a different place would share
 * extensions Dan disabled here. A corrupt file, or one with a version this code does not know, is ignored too.
 *
 * It is written to a temp name and renamed over the real one, so a start killed mid-write never leaves half a
 * file: the old snapshot (or none) is still there. The file is not secret: it holds extension ids only.
 */
import * as path from "node:path";
import { normaliseFolderUri } from "../profile/mirrored-profile";
import { isMissing, realMirrorFs, type MirrorFs } from "./mirror-fs";

export const SNAPSHOT_FILE = "mirror-snapshot.json";
export const SNAPSHOT_VERSION = 1;

export interface MirrorSnapshot {
  version: typeof SNAPSHOT_VERSION;
  instanceId: string;
  /** The mirrored profile's location id (a fixed id for Default). */
  profileLocation: string;
  vaultPath: string;
  /** When the read was made, ms since the epoch. */
  takenAt: number;
  /** Lower case, sorted, no duplicates. */
  disabled: string[];
}

/** Who a snapshot must belong to for it to be used. */
export interface SnapshotOwner {
  instanceId: string;
  profileLocation: string;
  vaultPath: string;
}

export type SnapshotRead = { status: "found"; snapshot: MirrorSnapshot } | { status: "none"; why: string };

function isSnapshot(v: unknown): v is MirrorSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.instanceId === "string" &&
    typeof s.profileLocation === "string" &&
    typeof s.vaultPath === "string" &&
    typeof s.takenAt === "number" &&
    Number.isFinite(s.takenAt) &&
    Array.isArray(s.disabled) &&
    s.disabled.every((d) => typeof d === "string")
  );
}

/** The snapshot in `dataDir`, if there is one that belongs to `owner`. Never throws. */
export async function readSnapshot(dataDir: string, owner: SnapshotOwner, io: MirrorFs = realMirrorFs): Promise<SnapshotRead> {
  let text: string;
  try {
    text = await io.readFile(path.join(dataDir, SNAPSHOT_FILE), "utf8");
  } catch (e) {
    return { status: "none", why: isMissing(e) ? "there is no earlier snapshot" : "the earlier snapshot could not be read" };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: "none", why: "the earlier snapshot is corrupt" };
  }
  const version = (json as { version?: unknown } | null)?.version;
  if (version !== SNAPSHOT_VERSION) return { status: "none", why: "the earlier snapshot has a version this plugin does not know" };
  if (!isSnapshot(json)) return { status: "none", why: "the earlier snapshot is corrupt" };
  if (json.instanceId !== owner.instanceId) return { status: "none", why: "the earlier snapshot is for another VS Code instance" };
  if (json.profileLocation !== owner.profileLocation) return { status: "none", why: "the earlier snapshot is for another profile" };
  if (normaliseFolderUri(json.vaultPath) !== normaliseFolderUri(owner.vaultPath)) return { status: "none", why: "the earlier snapshot is for another vault" };
  return { status: "found", snapshot: json };
}

/** Write the snapshot to a temp name in `dataDir`, then rename it over the real file. Throws if it cannot. */
export async function writeSnapshot(dataDir: string, snapshot: MirrorSnapshot, io: MirrorFs = realMirrorFs): Promise<void> {
  await io.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, SNAPSHOT_FILE);
  const temp = `${file}.${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await io.writeFile(temp, JSON.stringify(snapshot));
    await io.rename(temp, file);
  } catch (e) {
    await io.rm(temp, { force: true }).catch(() => undefined);
    throw e;
  }
}
