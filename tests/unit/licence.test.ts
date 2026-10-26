/**
 * The licence step: first-open prompt, accept sets the flag, decline and Escape
 * leave it false, the flag survives a data.json reload, one prompt for
 * concurrent callers, one answer for a double click. The modal is the real
 * ChoiceModal on the mocked Obsidian Modal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../mocks/obsidian";
import { LicenceGate, SERVER_LICENCE_URL, type LicenceStore } from "../../src/licence";
import { ChoiceModal, promptCloseDirty, promptLicence } from "../../src/modals";

/** A store backed by a JSON string, as data.json is: what is saved is read back by a "new" session. */
function diskStore(disk: { json: string }): LicenceStore & { writes: number } {
  const store = {
    writes: 0,
    accepted: () => (JSON.parse(disk.json) as { serverLicenceAccepted?: boolean }).serverLicenceAccepted === true,
    setAccepted: async (v: boolean) => {
      store.writes++;
      disk.json = JSON.stringify({ ...JSON.parse(disk.json), serverLicenceAccepted: v });
    },
  };
  return store;
}

const app = {} as never;
const lastModal = () => Modal.opened[Modal.opened.length - 1] as unknown as { contentEl: import("../mocks/obsidian").FakeNode; close(): void };
const button = (label: string) => {
  const b = lastModal().contentEl.buttons().find((n) => n.text === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b;
};

beforeEach(() => Modal.reset());

describe("LicenceGate", () => {
  it("asks on the first request, and accepting sets the flag", async () => {
    const disk = { json: "{}" };
    const prompt = vi.fn(async () => true);
    const gate = new LicenceGate(diskStore(disk), prompt);
    expect(gate.accepted).toBe(false);
    await expect(gate.request()).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(gate.accepted).toBe(true);
    expect(JSON.parse(disk.json)).toEqual({ serverLicenceAccepted: true });
  });

  it("does not ask again once accepted, and the flag survives a reload of data.json", async () => {
    const disk = { json: "{}" };
    await new LicenceGate(diskStore(disk), async () => true).request();
    const reloaded = new LicenceGate(diskStore({ json: disk.json }), async () => {
      throw new Error("must not prompt after a reload");
    });
    expect(reloaded.accepted).toBe(true);
    await expect(reloaded.request()).resolves.toBe(true);
  });

  it("declining leaves the flag false and writes nothing; the next request asks again", async () => {
    const disk = { json: "{}" };
    const store = diskStore(disk);
    const prompt = vi.fn(async () => false);
    const gate = new LicenceGate(store, prompt);
    await expect(gate.request()).resolves.toBe(false);
    expect(gate.accepted).toBe(false);
    expect(store.writes).toBe(0);
    expect(disk.json).toBe("{}");
    await expect(gate.request()).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("callers that arrive while the modal is open share one prompt and one answer", async () => {
    let answer!: (v: boolean) => void;
    const prompt = vi.fn(() => new Promise<boolean>((r) => (answer = r)));
    const store = diskStore({ json: "{}" });
    const gate = new LicenceGate(store, prompt);
    const all = [gate.request(), gate.request(), gate.request()];
    answer(true);
    await expect(Promise.all(all)).resolves.toEqual([true, true, true]);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(store.writes).toBe(1);
  });

  it("a rejected prompt does not wedge the gate", async () => {
    const prompt = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(true);
    const gate = new LicenceGate(diskStore({ json: "{}" }), prompt);
    await expect(gate.request()).rejects.toThrow("boom");
    await expect(gate.request()).resolves.toBe(true);
  });
});

describe("the licence modal", () => {
  it("states what is downloaded, from whom, and where the terms are, with Decline and Accept buttons", async () => {
    const pending = promptLicence(app);
    const text = lastModal().contentEl.textContent();
    expect(text).toContain("VS Code server licence");
    expect(text).toContain("downloaded from Microsoft");
    expect(text).toContain(SERVER_LICENCE_URL);
    expect(text).toContain("Nothing is downloaded until you accept");
    expect(lastModal().contentEl.buttons().map((b) => b.text)).toEqual(["Decline", "Accept and download"]);
    button("Decline").click();
    await pending;
  });

  it("Accept resolves true", async () => {
    const pending = promptLicence(app);
    button("Accept and download").click();
    await expect(pending).resolves.toBe(true);
  });

  it("Decline resolves false", async () => {
    const pending = promptLicence(app);
    button("Decline").click();
    await expect(pending).resolves.toBe(false);
  });

  it("Escape (the modal closing with no button pressed) counts as a decline", async () => {
    const pending = promptLicence(app);
    lastModal().close();
    await expect(pending).resolves.toBe(false);
  });

  it("through the gate: Escape leaves the flag false and writes nothing", async () => {
    const disk = { json: "{}" };
    const gate = new LicenceGate(diskStore(disk), () => promptLicence(app));
    const req = gate.request();
    lastModal().close();
    await expect(req).resolves.toBe(false);
    expect(disk.json).toBe("{}");
  });

  it("a double click on Accept answers once: one flag write, one start", async () => {
    const store = diskStore({ json: "{}" });
    const onAccepted = vi.fn();
    const gate = new LicenceGate(store, () => promptLicence(app));
    const req = gate.request().then((ok) => ok && onAccepted());
    const accept = button("Accept and download");
    accept.click();
    accept.click();
    await req;
    expect(store.writes).toBe(1);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(accept.disabled).toBe(true);
  });

  it("a button pressed after Escape is ignored (first answer wins)", async () => {
    const pending = promptLicence(app);
    const accept = button("Accept and download");
    lastModal().close();
    accept.click();
    await expect(pending).resolves.toBe(false);
  });
});

describe("ChoiceModal", () => {
  it("settles with the dismiss value when closed, whatever type it is", async () => {
    const m = new ChoiceModal<"save" | "discard">(app, { title: "t", lines: ["l"], choices: [{ label: "Discard", value: "discard" }], dismiss: "save" });
    const r = m.ask();
    (m as unknown as { close(): void }).close();
    await expect(r).resolves.toBe("save");
  });

  it("lets the title and the text break anywhere, so a long file name stays inside the modal (C32)", () => {
    void promptCloseDirty(app, { file: "a_very_long_file_name_with_no_spaces_at_all.py", state: "dirty" });
    const nodes = lastModal().contentEl.all();
    const text = nodes.filter((n) => n.tag === "h2" || n.tag === "p");
    expect(text.map((n) => n.tag)).toEqual(["h2", "p"]);
    expect(text[0].text).toContain("a_very_long_file_name_with_no_spaces_at_all.py");
    for (const n of text) expect(n.style.overflowWrap).toBe("anywhere");
  });
});
