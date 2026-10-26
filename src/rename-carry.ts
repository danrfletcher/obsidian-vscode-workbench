/**
 * Unsaved edits across a rename (G3). When Obsidian renames a file that a Code tab holds unsaved edits for,
 * the file has already moved on disk, but the workbench's buffer is still bound to the old path. Saving
 * writes the edits to the OLD path, which brings that file back, while the renamed file keeps its pre-edit
 * text. `carryEdits` fixes that after the save: the text at the old path moves into the renamed file and the
 * old path goes away again.
 *
 * It is careful with the user's text. Nothing is overwritten unless the renamed file is still exactly what it
 * was when the rename was noticed (`baseline`), the old file is only removed once the new file has been
 * written and read back, and anything else (the renamed file changed meanwhile) is left alone and reported as
 * a "conflict" so the user can be told where the edits are.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type CarryResult =
  /** The old path holds nothing (the edits were discarded or never saved): there is nothing to move. */
  | "none"
  /** The text at the old path is now in the renamed file and the old path is gone. */
  | "carried"
  /** The renamed file changed since the rename: both files are left as they are, the edits are in the old one. */
  | "conflict";

function resolveInside(root: string, rel: string): string | null {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  return abs === base || !abs.startsWith(base + path.sep) ? null : abs;
}

async function readOrNull(abs: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/** The bytes of the renamed file as they are now, or null when it cannot be read. Taken when the rename is noticed. */
export async function readBaseline(root: string, rel: string): Promise<Buffer | null> {
  const abs = resolveInside(root, rel);
  return abs ? readOrNull(abs) : null;
}

/**
 * A fingerprint of the file now (size, modification time, inode), or null when there is no file or it cannot be
 * read. A file written, replaced or created since an earlier fingerprint has a different one.
 */
export async function statSignature(root: string, rel: string): Promise<string | null> {
  const abs = resolveInside(root, rel);
  if (!abs) return null;
  try {
    const st = await fs.stat(abs, { bigint: true });
    return `${st.size}:${st.mtimeNs}:${st.ino}`;
  } catch {
    return null;
  }
}

/** Move the text a save wrote to `from` into `to`, the file that `from` was renamed to. */
export async function carryEdits(root: string, from: string, to: string, baseline: Buffer | null): Promise<CarryResult> {
  const oldAbs = resolveInside(root, from);
  const newAbs = resolveInside(root, to);
  if (!oldAbs || !newAbs || oldAbs === newAbs) return "none";
  const edited = await readOrNull(oldAbs);
  if (!edited) return "none";
  const current = await readOrNull(newAbs);
  if (!current) return "conflict"; // the renamed file is gone or unreadable: do not recreate anything
  if (!current.equals(edited)) {
    if (!baseline || !current.equals(baseline)) return "conflict";
    await fs.writeFile(newAbs, edited);
    const written = await readOrNull(newAbs);
    if (!written || !written.equals(edited)) return "conflict"; // the old file is kept: it still holds the edits
  }
  await fs.rm(oldAbs, { force: true });
  return "carried";
}
