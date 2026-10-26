import { describe, expect, it } from "vitest";
import { trackObsidianCreates } from "../../src/vault-sync";

function fakeVault() {
  const calls: Array<{ name: string; args: unknown[]; self: unknown }> = [];
  const vault: Record<string, any> = {};
  for (const name of ["create", "createBinary", "copy"]) {
    vault[name] = function (this: unknown, ...args: unknown[]) {
      calls.push({ name, args, self: this });
      return Promise.resolve(`${name}-result`);
    };
  }
  return { vault, calls, originals: { ...vault } };
}

describe("trackObsidianCreates", () => {
  it("reports the path of create, createBinary and copy (the new path, not the source) and still runs the original with the same arguments", async () => {
    const { vault, calls } = fakeVault();
    const heard: string[] = [];
    trackObsidianCreates({ vault }, (p) => heard.push(p));
    expect(await vault.create("a/new.py", "data")).toBe("create-result");
    expect(await vault.createBinary("b.bin", new ArrayBuffer(1))).toBe("createBinary-result");
    const source = { path: "src.py" };
    expect(await vault.copy(source, "copy of src.py")).toBe("copy-result");
    expect(heard).toEqual(["a/new.py", "b.bin", "copy of src.py"]);
    expect(calls.map((c) => c.name)).toEqual(["create", "createBinary", "copy"]);
    expect(calls[0].args).toEqual(["a/new.py", "data"]);
    expect(calls[2].args).toEqual([source, "copy of src.py"]);
    expect(calls.every((c) => c.self === vault)).toBe(true);
  });

  it("a listener that throws does not break the create", async () => {
    const { vault } = fakeVault();
    trackObsidianCreates({ vault }, () => {
      throw new Error("boom");
    });
    expect(await vault.create("x.py", "")).toBe("create-result");
  });

  it("the returned function puts the originals back", () => {
    const { vault, originals } = fakeVault();
    const restore = trackObsidianCreates({ vault }, () => undefined);
    expect(vault.create).not.toBe(originals.create);
    restore();
    expect(vault.create).toBe(originals.create);
    expect(vault.createBinary).toBe(originals.createBinary);
    expect(vault.copy).toBe(originals.copy);
  });

  it("copes with a vault that lacks some of the calls", () => {
    const restore = trackObsidianCreates({ vault: {} }, () => undefined);
    restore();
    trackObsidianCreates({}, () => undefined)();
  });
});
