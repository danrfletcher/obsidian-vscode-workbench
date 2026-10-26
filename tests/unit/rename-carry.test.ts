/** Moving the text a save wrote to a renamed file's old path into the renamed file (G3), against real files. */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { carryEdits, readBaseline, statSignature } from "../../src/rename-carry";
import { tempDir } from "../helpers";

function vault(files: Record<string, string>): string {
  const root = tempDir();
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}
const read = (root: string, name: string) => (fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), "utf8") : null);

describe("carryEdits", () => {
  it("moves the old path's text into the renamed file when that file is still as it was, and removes the old path", async () => {
    const root = vault({ "a b.py": "edited\n", "ünï.py": "old\n" });
    const baseline = await readBaseline(root, "ünï.py");
    expect(await carryEdits(root, "a b.py", "ünï.py", baseline)).toBe("carried");
    expect(read(root, "ünï.py")).toBe("edited\n");
    expect(read(root, "a b.py")).toBeNull();
  });

  it("works across folders", async () => {
    const root = vault({ "x/a.py": "edited\n", "y/z/a.py": "old\n" });
    expect(await carryEdits(root, "x/a.py", "y/z/a.py", await readBaseline(root, "y/z/a.py"))).toBe("carried");
    expect(read(root, "y/z/a.py")).toBe("edited\n");
    expect(read(root, "x/a.py")).toBeNull();
  });

  it("does nothing when the old path holds nothing (the edits were discarded)", async () => {
    const root = vault({ "b.py": "old\n" });
    expect(await carryEdits(root, "a.py", "b.py", await readBaseline(root, "b.py"))).toBe("none");
    expect(read(root, "b.py")).toBe("old\n");
    expect(read(root, "a.py")).toBeNull();
  });

  it("never overwrites a renamed file that changed since the rename, and keeps the old file with the edits", async () => {
    const root = vault({ "a.py": "edited\n", "b.py": "old\n" });
    const baseline = await readBaseline(root, "b.py");
    fs.writeFileSync(path.join(root, "b.py"), "changed elsewhere\n");
    expect(await carryEdits(root, "a.py", "b.py", baseline)).toBe("conflict");
    expect(read(root, "b.py")).toBe("changed elsewhere\n");
    expect(read(root, "a.py")).toBe("edited\n");
  });

  it("with no baseline it only removes the old file when the two already hold the same text", async () => {
    const root = vault({ "a.py": "same\n", "b.py": "same\n", "c.py": "edited\n", "d.py": "old\n" });
    expect(await carryEdits(root, "a.py", "b.py", null)).toBe("carried");
    expect(read(root, "a.py")).toBeNull();
    expect(await carryEdits(root, "c.py", "d.py", null)).toBe("conflict");
    expect(read(root, "c.py")).toBe("edited\n");
    expect(read(root, "d.py")).toBe("old\n");
  });

  it("does not recreate a renamed file that is gone", async () => {
    const root = vault({ "a.py": "edited\n" });
    expect(await carryEdits(root, "a.py", "b.py", Buffer.from("old\n"))).toBe("conflict");
    expect(read(root, "b.py")).toBeNull();
    expect(read(root, "a.py")).toBe("edited\n");
  });

  it("refuses paths that leave the vault", async () => {
    const root = vault({ "a.py": "edited\n", "b.py": "old\n" });
    expect(await carryEdits(root, "../a.py", "b.py", Buffer.from("old\n"))).toBe("none");
    expect(await carryEdits(root, "a.py", "../b.py", Buffer.from("old\n"))).toBe("none");
    expect(await readBaseline(root, "../b.py")).toBeNull();
    expect(read(root, "a.py")).toBe("edited\n");
    expect(read(root, "b.py")).toBe("old\n");
  });
});

describe("statSignature", () => {
  it("is null for no file or a path outside the vault, and changes when the file is created, written or replaced", async () => {
    const root = vault({});
    expect(await statSignature(root, "a.py")).toBeNull();
    expect(await statSignature(root, "../a.py")).toBeNull();
    fs.writeFileSync(path.join(root, "a.py"), "one\n");
    const created = await statSignature(root, "a.py");
    expect(created).not.toBeNull();
    expect(await statSignature(root, "a.py")).toBe(created); // looking changes nothing
    fs.writeFileSync(path.join(root, "a.py"), "two two\n");
    const written = await statSignature(root, "a.py");
    expect(written).not.toBe(created);
    fs.rmSync(path.join(root, "a.py"));
    fs.writeFileSync(path.join(root, "a.py"), "two two\n");
    expect(await statSignature(root, "a.py")).not.toBe(written);
  });
});
