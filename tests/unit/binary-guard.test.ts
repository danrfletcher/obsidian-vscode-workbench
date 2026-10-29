/** The binary and huge-file guard (E6). Fixtures are generated in a temp dir. */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES, SNIFF_BYTES, checkFile, hasNullByte, refusalMessage } from "../../src/binary-guard";
import { tempDir } from "../helpers";

function file(name: string, content: Buffer | string | null, sparseSize?: number): string {
  const p = path.join(tempDir(), name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (sparseSize !== undefined) {
    fs.writeFileSync(p, "");
    fs.truncateSync(p, sparseSize);
  } else {
    fs.writeFileSync(p, content ?? "");
  }
  return p;
}

/** `size` bytes of "a", with a null byte at `nullAt` (when given). */
function withNullAt(size: number, nullAt: number | null): Buffer {
  const b = Buffer.alloc(size, 0x61);
  if (nullAt !== null) b[nullAt] = 0;
  return b;
}

afterEach(() => vi.restoreAllMocks());

describe("constants", () => {
  it("are 2 MiB and 8 KiB", () => {
    expect(MAX_FILE_BYTES).toBe(2_097_152);
    expect(SNIFF_BYTES).toBe(8192);
  });
});

describe("size boundary", () => {
  it("2,097,152 bytes opens", async () => {
    expect(await checkFile(file("edge.txt", Buffer.alloc(2_097_152, 0x61)))).toEqual({ ok: true });
  });

  it("2,097,153 bytes is refused as too large", async () => {
    expect(await checkFile(file("over.txt", Buffer.alloc(2_097_153, 0x61)))).toEqual({ ok: false, reason: "too-large", size: 2_097_153 });
  });

  it("a 500 MB sparse file is refused on size without being read", async () => {
    const p = file("huge.log", null, 500 * 1024 * 1024);
    const realOpen = fs.promises.open.bind(fs.promises);
    const reads: Array<{ length: number; position: unknown }> = [];
    vi.spyOn(fs.promises, "open").mockImplementation((async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      (handle as unknown as { read: unknown }).read = (...a: unknown[]) => {
        reads.push({ length: a[2] as number, position: a[3] });
        return (realRead as (...x: unknown[]) => unknown)(...a);
      };
      return handle;
    }) as never);
    const result = await checkFile(p);
    expect(result).toEqual({ ok: false, reason: "too-large", size: 500 * 1024 * 1024 });
    expect(reads).toEqual([]);
  });
});

describe("null-byte window", () => {
  it.each([
    [0, false],
    [100, false],
    [8191, false],
    [8192, true],
    [8193, true],
    [50_000, true],
  ])("a null byte at offset %i: opens = %s", async (offset, opens) => {
    const result = await checkFile(file("n.dat", withNullAt(60_000, offset)));
    expect(result.ok).toBe(opens);
    if (!opens) expect(result).toEqual({ ok: false, reason: "binary" });
  });

  it("a small file whose null byte is inside the window is refused", async () => {
    expect(await checkFile(file("tiny.bin", Buffer.from([0x61, 0, 0x62])))).toEqual({ ok: false, reason: "binary" });
  });

  it("reads only the first 8 KB, not the whole file", async () => {
    const p = file("big.txt", withNullAt(1_500_000, 900_000));
    const realOpen = fs.promises.open.bind(fs.promises);
    const reads: Array<{ length: number; position: unknown }> = [];
    vi.spyOn(fs.promises, "open").mockImplementation((async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await realOpen(...args);
      const realRead = handle.read.bind(handle);
      (handle as unknown as { read: unknown }).read = (...a: unknown[]) => {
        reads.push({ length: a[2] as number, position: a[3] });
        return (realRead as (...x: unknown[]) => unknown)(...a);
      };
      return handle;
    }) as never);
    expect(await checkFile(p)).toEqual({ ok: true });
    expect(reads).toEqual([{ length: 8192, position: 0 }]);
  });
});

describe("files that open normally", () => {
  it("an empty file", async () => {
    expect(await checkFile(file("empty.txt", ""))).toEqual({ ok: true });
  });

  it("a UTF-8 file with non-ASCII text, with multi-byte characters across the 8 KB boundary", async () => {
    const text = "héllo wörld — 文件 ✓ ".repeat(2000);
    expect(Buffer.byteLength(text)).toBeGreaterThan(8192);
    expect(await checkFile(file("utf8.txt", text))).toEqual({ ok: true });
  });

  it("a file with spaces and non-ASCII in its path", async () => {
    expect(await checkFile(file("Mock Exams/scripts/estimaté tïme 文件.py", "x = 1\n"))).toEqual({ ok: true });
  });
});

describe("unreadable files", () => {
  it("a missing file is a refusal with a reason, not a throw", async () => {
    const r = await checkFile(path.join(tempDir(), "nope.txt"));
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ reason: "unreadable" });
  });

  it("a folder is a refusal, not a throw", async () => {
    const r = await checkFile(tempDir());
    expect(r.ok).toBe(false);
  });
});

describe("refusalMessage", () => {
  it("names the file and says where it goes", () => {
    expect(refusalMessage("a.bin", { ok: false, reason: "binary" })).toMatch(/a\.bin.*binary.*system's app/);
    expect(refusalMessage("big.log", { ok: false, reason: "too-large", size: 3_000_000 })).toMatch(/big\.log.*2 MB.*system's app/);
    expect(refusalMessage("x", { ok: false, reason: "unreadable", detail: "EACCES" })).toMatch(/EACCES/);
    expect(refusalMessage("x", { ok: false, reason: "unreadable", detail: "EACCES" })).not.toMatch(/system's app/);
  });
});

describe("hasNullByte", () => {
  it("looks only at the first 8192 bytes of what it is given", () => {
    expect(hasNullByte(withNullAt(9000, 8191))).toBe(true);
    expect(hasNullByte(withNullAt(9000, 8192))).toBe(false);
  });
});
