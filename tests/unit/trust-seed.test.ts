import { describe, expect, it } from "vitest";
import { TRUST_DB_NAME, TRUST_KEY, TRUST_STORE, buildTrustSeedScript, keepPorts, trustEntryFor, type TrustSeedInput } from "../../src/trust/trust-seed";

/**
 * The smallest IndexedDB the trust script touches (same hand-written pattern as `fakeIndexedDB` in settings.test.ts, with
 * databases by name, optional version, and a readwrite transaction that completes once its requests have run).
 */
function fakeStateDB(initial?: { stores?: string[]; items?: Record<string, unknown> }) {
  const dbs = new Map<string, Map<string, Map<string, unknown>>>();
  const state = { opened: [] as Array<[string, number | undefined]>, closed: 0, puts: [] as Array<[string, unknown]>, transactions: [] as string[] };
  if (initial) {
    const stores = new Map<string, Map<string, unknown>>();
    for (const s of initial.stores ?? [TRUST_STORE]) stores.set(s, new Map());
    for (const [k, v] of Object.entries(initial.items ?? {})) stores.get(TRUST_STORE)?.set(k, v);
    dbs.set(TRUST_DB_NAME, stores);
  }
  const indexedDB = {
    open: (name: string, version?: number) => {
      state.opened.push([name, version]);
      const r: { result?: unknown; error?: unknown; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void } = {};
      queueMicrotask(() => {
        let stores = dbs.get(name);
        const created = stores === undefined;
        if (!stores) dbs.set(name, (stores = new Map()));
        const live = stores;
        r.result = {
          objectStoreNames: { contains: (n: string) => live.has(n) },
          createObjectStore: (n: string) => live.set(n, new Map()),
          close: () => void state.closed++,
          transaction: (n: string, mode?: string) => {
            state.transactions.push(`${n}:${mode}`);
            let pending = 0;
            const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void; error?: unknown; objectStore: (x: string) => unknown } = {
              objectStore: () => ({
                get: (k: string) => {
                  const q: { result?: unknown; onsuccess?: () => void } = {};
                  pending++;
                  queueMicrotask(() => {
                    q.result = live.get(n)?.get(k);
                    q.onsuccess?.();
                    done();
                  });
                  return q;
                },
                put: (v: unknown, k: string) => {
                  pending++;
                  state.puts.push([k, v]);
                  queueMicrotask(() => {
                    live.get(n)?.set(k, v);
                    done();
                  });
                },
              }),
            };
            const done = () => {
              if (--pending === 0) queueMicrotask(() => tx.oncomplete?.());
            };
            return tx;
          },
        };
        if (created) r.onupgradeneeded?.();
        r.onsuccess?.();
      });
      return r;
    },
  };
  const record = () => {
    const raw = dbs.get(TRUST_DB_NAME)?.get(TRUST_STORE)?.get(TRUST_KEY);
    return raw === undefined ? undefined : (JSON.parse(raw as string) as { uriTrustInfo: Array<{ uri: { path: string; scheme: string; authority: string; $mid: number }; trusted: boolean }>; [k: string]: unknown });
  };
  return { indexedDB, dbs, state, record, raw: () => dbs.get(TRUST_DB_NAME)?.get(TRUST_STORE)?.get(TRUST_KEY) };
}

const ORIGIN = "http://127.0.0.1:51789";
const VAULT = "/Users/dan/Notes";
const uriOf = (origin: string, vault: string) => `vscode-remote://${new URL(origin).host}${vault.split("/").map(encodeURIComponent).join("/")}`;
const input = (over: Partial<TrustSeedInput> = {}): TrustSeedInput => ({ origin: ORIGIN, folderUri: uriOf(ORIGIN, VAULT), heldPorts: [51789], ...over });
const entry = (authority: string, path: string) => ({ uri: { $mid: 1, path, scheme: "vscode-remote", authority }, trusted: true });

async function run(fake: ReturnType<typeof fakeStateDB>, inp: TrustSeedInput = input()) {
  const fn = new Function("indexedDB", `return ${buildTrustSeedScript(inp)}`) as (db: unknown) => Promise<string>;
  return fn(fake.indexedDB);
}

describe("buildTrustSeedScript: the record for the vault folder (G5, G17)", () => {
  it("writes the record PR-1 measured, under the measured database, store and key, for the vault folder only", async () => {
    const fake = fakeStateDB();
    expect(await run(fake)).toBe("seeded");
    expect(fake.state.opened).toEqual([["vscode-web-state-db-global-shared", undefined]]); // opened without a version: VS Code owns the schema
    expect(fake.state.transactions).toEqual(["ItemTable:readwrite"]);
    expect(fake.raw()).toBe('{"uriTrustInfo":[{"uri":{"$mid":1,"path":"/Users/dan/Notes","scheme":"vscode-remote","authority":"127.0.0.1:51789"},"trusted":true}]}');
    expect(fake.state.closed).toBe(1);
  });

  it("writes exactly one entry, and it names the vault folder: no parent, sibling, home or wildcard entry (G17)", async () => {
    const fake = fakeStateDB();
    await run(fake);
    const infos = fake.record()?.uriTrustInfo ?? [];
    expect(infos).toHaveLength(1);
    expect(infos[0].uri.path).toBe(VAULT);
    for (const bad of ["/", "/Users", "/Users/dan", "/Users/dan/Notes/sub", "/Users/dan/Other", "*", "/Users/dan/*"]) {
      expect(infos.map((i) => i.uri.path)).not.toContain(bad);
    }
    expect(JSON.stringify(fake.record())).not.toContain("*");
  });

  it("leaves a folder that was opened on the same server and is not the vault untrusted: the seed adds no entry for it", async () => {
    const fake = fakeStateDB();
    await run(fake);
    const trusted = (p: string) => (fake.record()?.uriTrustInfo ?? []).some((i) => i.uri.authority === "127.0.0.1:51789" && i.uri.path === p && i.trusted);
    expect(trusted(VAULT)).toBe(true);
    expect(trusted("/Users/dan/Other")).toBe(false);
    expect(trusted("/Users/dan/Notes-sibling")).toBe(false);
  });

  it("is idempotent: running twice, or in two tabs, leaves one record with the same bytes (E11)", async () => {
    const fake = fakeStateDB();
    await run(fake);
    const once = fake.raw();
    expect(await run(fake)).toBe("seeded");
    expect(await run(fake)).toBe("seeded");
    expect(fake.raw()).toBe(once);
    expect(fake.record()?.uriTrustInfo).toHaveLength(1);
  });

  it("keeps an entry for another folder the user trusted by hand on this server, and the other keys of the record", async () => {
    const hand = entry("127.0.0.1:51789", "/Users/dan/Other");
    const fake = fakeStateDB({ items: { [TRUST_KEY]: JSON.stringify({ extra: 1, uriTrustInfo: [hand] }) } });
    await run(fake);
    expect(fake.record()).toEqual({ extra: 1, uriTrustInfo: [hand, entry("127.0.0.1:51789", VAULT)] });
  });

  it("replaces an untrusted or duplicate entry for the vault folder with one trusted entry", async () => {
    const stored = [{ ...entry("127.0.0.1:51789", VAULT), trusted: false }, entry("127.0.0.1:51789", VAULT)];
    const fake = fakeStateDB({ items: { [TRUST_KEY]: JSON.stringify({ uriTrustInfo: stored }) } });
    await run(fake);
    expect(fake.record()?.uriTrustInfo).toEqual([entry("127.0.0.1:51789", VAULT)]);
  });
});

// The pruning filter is defensive: a real browser profile keeps one database per origin, so entries for other ports are
// not normally in the database the script edits (the real-server check, tests/render/trust-check.mjs, shows the old
// origin's record stays in its own database). These tests place such entries in one database to pin the filter's rules.
describe("buildTrustSeedScript: the defensive pruning filter and the keep-list (G5, E11)", () => {
  const old = entry("127.0.0.1:40000", VAULT);
  const other = entry("127.0.0.1:41000", VAULT);
  const stored = (...e: unknown[]) => fakeStateDB({ items: { [TRUST_KEY]: JSON.stringify({ uriTrustInfo: e }) } });

  it("removes a record for a port no running server holds", async () => {
    const fake = stored(old);
    await run(fake, input({ heldPorts: [51789] }));
    expect(fake.record()?.uriTrustInfo).toEqual([entry("127.0.0.1:51789", VAULT)]);
  });

  it("never removes a record for a port in the held-ports list, and removes the others in the same run", async () => {
    const fake = stored(old, other);
    await run(fake, input({ heldPorts: [41000, 51789] }));
    expect(fake.record()?.uriTrustInfo).toEqual([other, entry("127.0.0.1:51789", VAULT)]);
  });

  it("keeps this server's own port even when the held list does not name it", async () => {
    const own = entry("127.0.0.1:51789", "/Users/dan/Other");
    const fake = stored(own, old);
    await run(fake, input({ heldPorts: [41000] }));
    expect(fake.record()?.uriTrustInfo).toEqual([own, entry("127.0.0.1:51789", VAULT)]);
  });

  it.each([
    ["empty", []],
    ["missing", undefined],
    ["null", null],
    ["not a list", "51789" as unknown as number[]],
    ["only invalid ports", [0, -1, 70000, 1.5, Number.NaN, "51789" as unknown as number]],
  ])("removes nothing when the held-ports list is %s", async (_name, held) => {
    const fake = stored(old, other);
    await run(fake, input({ heldPorts: held as number[] }));
    expect(fake.record()?.uriTrustInfo).toEqual([old, other, entry("127.0.0.1:51789", VAULT)]);
  });

  it("removes nothing it cannot be sure is a stale server record: other schemes, other hosts, odd entries", async () => {
    const keepers = [
      { uri: { $mid: 1, path: VAULT, scheme: "file", authority: "" }, trusted: true },
      { uri: { $mid: 1, path: VAULT, scheme: "vscode-remote", authority: "example.com:40000" }, trusted: true },
      { uri: { $mid: 1, path: VAULT, scheme: "vscode-remote", authority: "127.0.0.1" }, trusted: true },
      { uri: { $mid: 1, path: VAULT, scheme: "vscode-remote" }, trusted: true },
      { uri: null },
      "text",
      null,
    ];
    const fake = stored(...keepers);
    await run(fake);
    expect(fake.record()?.uriTrustInfo).toEqual([...keepers, entry("127.0.0.1:51789", VAULT)]);
  });

  it("a restart on a new port passes the new port and keeps the other running server's record", async () => {
    // first start on 51789 and a second vault's server on 52000, then this vault restarts on 53000
    const fake = fakeStateDB();
    await run(fake, input({ heldPorts: [51789, 52000] }));
    const second = entry("127.0.0.1:52000", "/Users/dan/Second");
    fake.dbs.get(TRUST_DB_NAME)?.get(TRUST_STORE)?.set(TRUST_KEY, JSON.stringify({ uriTrustInfo: [...(fake.record()?.uriTrustInfo ?? []), second] }));
    const origin = "http://127.0.0.1:53000";
    await run(fake, { origin, folderUri: uriOf(origin, VAULT), heldPorts: [52000, 53000] });
    expect(fake.record()?.uriTrustInfo).toEqual([second, entry("127.0.0.1:53000", VAULT)]);
  });
});

describe("buildTrustSeedScript: folder URI encoding", () => {
  it.each([
    ["spaces", "/Users/dan/My Notes", "/Users/dan/My%20Notes"],
    ["non-ASCII", "/Users/dan/Zürich 文件/ça", "/Users/dan/Z%C3%BCrich%20%E6%96%87%E4%BB%B6/%C3%A7a"],
    ["percent, hash and question mark", "/Users/dan/100%/a#b?c", "/Users/dan/100%25/a%23b%3Fc"],
    ["a trailing slash", "/Users/dan/Notes/", "/Users/dan/Notes"],
  ])("a vault path with %s is encoded by the rule in src/paths.ts and recorded as the decoded path", async (_name, vault, encodedPath) => {
    const folderUri = `vscode-remote://127.0.0.1:51789${encodedPath}${vault.endsWith("/") ? "/" : ""}`;
    const fake = fakeStateDB();
    expect(await run(fake, input({ folderUri }))).toBe("seeded");
    expect(fake.record()?.uriTrustInfo).toEqual([entry("127.0.0.1:51789", vault.replace(/\/$/, ""))]);
  });
});

describe("buildTrustSeedScript: input it refuses to build for (nothing is trusted by accident)", () => {
  it.each([
    ["the file system root", "vscode-remote://127.0.0.1:51789/"],
    ["a bare authority", "vscode-remote://127.0.0.1:51789"],
    ["another port than the origin", "vscode-remote://127.0.0.1:40000/Users/dan/Notes"],
    ["another host than the origin", "vscode-remote://example.com:51789/Users/dan/Notes"],
  ])("throws for %s", (_name, folderUri) => {
    expect(() => buildTrustSeedScript(input({ folderUri }))).toThrow();
  });

  it("throws for a folder URI that is not valid", () => {
    expect(() => buildTrustSeedScript(input({ folderUri: "not a uri" }))).toThrow();
  });

  it("trustEntryFor returns the one entry, in the shape VS Code writes", () => {
    expect(trustEntryFor(ORIGIN, uriOf(ORIGIN, VAULT))).toEqual(entry("127.0.0.1:51789", VAULT));
  });
});

describe("keepPorts", () => {
  it("is the held ports plus the origin's own, sorted, without duplicates or invalid values", () => {
    expect(keepPorts(ORIGIN, [52000, 51789, 52000, 0, 70000, 1.5])).toEqual([51789, 52000]);
  });

  it("is empty when nothing valid is held, whatever the origin", () => {
    expect(keepPorts(ORIGIN, [])).toEqual([]);
    expect(keepPorts(ORIGIN, undefined)).toEqual([]);
    expect(keepPorts(ORIGIN, null)).toEqual([]);
  });

  it("an origin with no explicit port adds nothing of its own", () => {
    expect(keepPorts("http://127.0.0.1", [52000])).toEqual([52000]);
  });
});

describe("buildTrustSeedScript: when VS Code's storage is not what the plugin expects (E3)", () => {
  it.each([
    ["is not JSON", "{ nope"],
    ["is an empty string", ""],
    ["is not a string", new Uint8Array([1])],
    ["is JSON null", "null"],
    ["is a JSON list", "[]"],
    ["is a JSON number", "7"],
    ["has a uriTrustInfo that is not a list", JSON.stringify({ uriTrustInfo: {} })],
  ])("answers version-mismatch and leaves the stored record alone when it %s", async (_name, value) => {
    const fake = fakeStateDB({ items: { [TRUST_KEY]: value } });
    expect(await run(fake)).toBe("version-mismatch");
    expect(fake.raw()).toBe(value);
    expect(fake.state.puts).toEqual([]);
    expect(fake.state.closed).toBe(1);
  });

  it("starts a record when the stored one has no uriTrustInfo yet", async () => {
    const fake = fakeStateDB({ items: { [TRUST_KEY]: JSON.stringify({ keep: true }) } });
    expect(await run(fake)).toBe("seeded");
    expect(fake.record()).toEqual({ keep: true, uriTrustInfo: [entry("127.0.0.1:51789", VAULT)] });
  });

  it("answers no-store when the database has no ItemTable store, and does not touch it", async () => {
    const fake = fakeStateDB({ stores: ["other"] });
    expect(await run(fake)).toBe("no-store");
    expect(fake.state.puts).toEqual([]);
    expect(fake.state.closed).toBe(1);
  });

  it("answers error:<name> when the database cannot be opened", async () => {
    const indexedDB = {
      open: () => {
        const r: { error: unknown; onerror?: () => void } = { error: { name: "SecurityError" } };
        queueMicrotask(() => r.onerror?.());
        return r;
      },
    };
    expect(await (new Function("indexedDB", `return ${buildTrustSeedScript(input())}`) as (d: unknown) => Promise<string>)(indexedDB)).toBe("error:SecurityError");
  });

  it("answers error:open when the open fails without a name", async () => {
    const indexedDB = {
      open: () => {
        const r: { error: unknown; onerror?: () => void } = { error: null };
        queueMicrotask(() => r.onerror?.());
        return r;
      },
    };
    expect(await (new Function("indexedDB", `return ${buildTrustSeedScript(input())}`) as (d: unknown) => Promise<string>)(indexedDB)).toBe("error:open");
  });

  it("answers error:<name> for a transaction the page refuses, and still closes the database", async () => {
    let closed = 0;
    const db = {
      objectStoreNames: { contains: () => true },
      close: () => void closed++,
      transaction: () => {
        throw Object.assign(new Error("denied"), { name: "SecurityError" });
      },
    };
    const indexedDB = { open: () => { const r: { result: unknown; onsuccess?: () => void } = { result: db }; queueMicrotask(() => r.onsuccess?.()); return r; } };
    expect(await (new Function("indexedDB", `return ${buildTrustSeedScript(input())}`) as (d: unknown) => Promise<string>)(indexedDB)).toBe("error:SecurityError");
    expect(closed).toBe(1);
  });

  it("answers error:<name> when the transaction aborts, and error:seed when it has no name", async () => {
    for (const [error, expected] of [[{ name: "QuotaExceededError" }, "error:QuotaExceededError"], [null, "error:seed"]] as const) {
      const db = {
        objectStoreNames: { contains: () => true },
        close: () => undefined,
        transaction: () => {
          const tx: { objectStore: () => unknown; onabort?: () => void; error: unknown } = {
            error,
            objectStore: () => ({ get: () => ({}), put: () => undefined }),
          };
          queueMicrotask(() => tx.onabort?.());
          return tx;
        },
      };
      const indexedDB = { open: () => { const r: { result: unknown; onsuccess?: () => void } = { result: db }; queueMicrotask(() => r.onsuccess?.()); return r; } };
      expect(await (new Function("indexedDB", `return ${buildTrustSeedScript(input())}`) as (d: unknown) => Promise<string>)(indexedDB)).toBe(expected);
    }
  });

  it("answers error:<name> when a request fails", async () => {
    const db = {
      objectStoreNames: { contains: () => true },
      close: () => undefined,
      transaction: () => ({
        objectStore: () => ({
          get: () => {
            const q: { error: unknown; onerror?: () => void } = { error: { name: "DataError" } };
            queueMicrotask(() => q.onerror?.());
            return q;
          },
        }),
      }),
    };
    const indexedDB = { open: () => { const r: { result: unknown; onsuccess?: () => void } = { result: db }; queueMicrotask(() => r.onsuccess?.()); return r; } };
    expect(await (new Function("indexedDB", `return ${buildTrustSeedScript(input())}`) as (d: unknown) => Promise<string>)(indexedDB)).toBe("error:DataError");
  });
});

describe("buildTrustSeedScript: what the script is made of", () => {
  it("is a self-contained async expression that mentions neither Workspace Trust settings nor a token", () => {
    const script = buildTrustSeedScript(input());
    expect(script.startsWith("(async () => {")).toBe(true);
    expect(script).not.toContain("security.workspace.trust");
    expect(script).not.toMatch(/tkn|token/i);
  });

  it("carries the folder, the keep-list and nothing about any other path", () => {
    const script = buildTrustSeedScript(input({ heldPorts: [52000, 51789] }));
    expect(script).toContain('"path":"/Users/dan/Notes"');
    expect(script).toContain("const keep = [51789,52000];");
    expect(script.match(/\/Users\//g)).toHaveLength(1);
  });
});
