/**
 * The binary and huge-file guard (E6): a file over 2 MB, or with a null byte in
 * its first 8 KB, is refused; the caller tells the user and hands the file to
 * the system app. The size is checked first from `stat`, so a huge (or sparse)
 * file is refused without being read; otherwise only the first 8 KB is read,
 * never the whole file.
 */
import * as fs from "node:fs";

/** 2 MiB: a file of exactly this many bytes opens; one byte more is refused. */
export const MAX_FILE_BYTES = 2_097_152;
/** The leading window searched for a null byte: offsets 0 to 8191. */
export const SNIFF_BYTES = 8192;

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: "too-large"; size: number }
  | { ok: false; reason: "binary" }
  | { ok: false; reason: "unreadable"; detail: string };

export function hasNullByte(buf: Uint8Array, length = buf.length): boolean {
  return buf.subarray(0, Math.min(length, SNIFF_BYTES)).includes(0);
}

/** Check one file on disk. Never throws: an unreadable file is a refusal with a reason. */
export async function checkFile(absPath: string): Promise<GuardResult> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(absPath, "r");
    const stat = await handle.stat();
    if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: "too-large", size: stat.size };
    if (stat.size === 0) return { ok: true };
    const buf = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return hasNullByte(buf, bytesRead) ? { ok: false, reason: "binary" } : { ok: true };
  } catch (e) {
    return { ok: false, reason: "unreadable", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The notice text for a refusal. `name` is the file's base name. A file that cannot be read at all is not handed to the system app. */
export function refusalMessage(name: string, result: Exclude<GuardResult, { ok: true }>): string {
  switch (result.reason) {
    case "too-large":
      return `VS Code Workbench: ${name} is larger than 2 MB, so it is not opened in a Code tab. Opening it in your system's app instead.`;
    case "binary":
      return `VS Code Workbench: ${name} looks like a binary file, so it is not opened in a Code tab. Opening it in your system's app instead.`;
    case "unreadable":
      return `VS Code Workbench: ${name} could not be read (${result.detail}), so it is not opened in a Code tab.`;
  }
}
