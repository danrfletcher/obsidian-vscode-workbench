import { describe, expect, it } from "vitest";
import { authorityOf, buildFileUri, buildFileUrl, buildFolderUrl, encodePathSegments, normalizeLine, targetOfUri, toAbsolutePath } from "../../src/paths";

const BASE = "http://127.0.0.1:5555";
const TOKEN = "tok123";

describe("toAbsolutePath", () => {
  it.each([
    ["/vault", "a.py", "/vault/a.py"],
    ["/vault/", "a.py", "/vault/a.py"],
    ["/vault", "/a.py", "/vault/a.py"],
    ["/vault", "", "/vault"],
    ["/My Vault", "Mock Exams/scripts/x.py", "/My Vault/Mock Exams/scripts/x.py"],
  ])("%s + %s", (root, rel, expected) => {
    expect(toAbsolutePath(root, rel)).toBe(expected);
  });
});

describe("encodePathSegments", () => {
  it.each([
    ["spaces", "/a b/c d.py", "/a%20b/c%20d.py"],
    ["hash", "/a#b/c.py", "/a%23b/c.py"],
    ["question mark", "/a?b/c.py", "/a%3Fb/c.py"],
    ["percent", "/100%/c.py", "/100%25/c.py"],
    ["accents", "/estimaté/tïme.py", "/estimat%C3%A9/t%C3%AFme.py"],
    ["CJK", "/文件/代码.py", "/%E6%96%87%E4%BB%B6/%E4%BB%A3%E7%A0%81.py"],
    ["emoji", "/🚀 go/a.py", "/%F0%9F%9A%80%20go/a.py"],
    ["plain", "/a/b/c.py", "/a/b/c.py"],
  ])("%s", (_name, input, expected) => {
    expect(encodePathSegments(input)).toBe(expected);
  });
});

describe("buildFileUri / authorityOf", () => {
  it("names the file on the server by host:port", () => {
    expect(authorityOf(BASE)).toBe("127.0.0.1:5555");
    expect(buildFileUri(BASE, "/v/a b.py")).toBe("vscode-remote://127.0.0.1:5555/v/a%20b.py");
  });
});

describe("buildFolderUrl", () => {
  it("encodes the folder and puts the token first", () => {
    expect(buildFolderUrl(BASE, "/Users/dan/My Vault", TOKEN)).toBe(
      "http://127.0.0.1:5555/?tkn=tok123&folder=%2FUsers%2Fdan%2FMy%20Vault",
    );
  });

  it("omits the token when none is given", () => {
    expect(buildFolderUrl(BASE, "/v")).toBe("http://127.0.0.1:5555/?folder=%2Fv");
  });
});

describe("buildFileUrl (E5)", () => {
  // The payload value is encodeURIComponent(JSON of [["openFile", <file uri>]]), so
  // the file path is percent-encoded once for the URI and once for the query.
  const cases: Array<[string, string, string, string]> = [
    [
      "plain",
      "/v",
      "a.py",
      "http://127.0.0.1:5555/?tkn=tok123&folder=%2Fv&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2F127.0.0.1%3A5555%2Fv%2Fa.py%22%5D%5D",
    ],
    [
      "spaces",
      "/v",
      "Mock Exams/a b.py",
      "http://127.0.0.1:5555/?tkn=tok123&folder=%2Fv&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2F127.0.0.1%3A5555%2Fv%2FMock%2520Exams%2Fa%2520b.py%22%5D%5D",
    ],
    [
      "hash",
      "/v",
      "c#/a.py",
      "http://127.0.0.1:5555/?tkn=tok123&folder=%2Fv&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2F127.0.0.1%3A5555%2Fv%2Fc%2523%2Fa.py%22%5D%5D",
    ],
    [
      "question mark",
      "/v",
      "why?.py",
      "http://127.0.0.1:5555/?tkn=tok123&folder=%2Fv&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2F127.0.0.1%3A5555%2Fv%2Fwhy%253F.py%22%5D%5D",
    ],
    [
      "percent",
      "/v",
      "100%.py",
      "http://127.0.0.1:5555/?tkn=tok123&folder=%2Fv&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2F127.0.0.1%3A5555%2Fv%2F100%2525.py%22%5D%5D",
    ],
    [
      "accents",
      "/v",
      "tïme.py",
      "http://127.0.0.1:5555/?tkn=tok123&folder=%2Fv&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2F127.0.0.1%3A5555%2Fv%2Ft%25C3%25AFme.py%22%5D%5D",
    ],
    [
      "CJK",
      "/v",
      "文件.py",
      "http://127.0.0.1:5555/?tkn=tok123&folder=%2Fv&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2F127.0.0.1%3A5555%2Fv%2F%25E6%2596%2587%25E4%25BB%25B6.py%22%5D%5D",
    ],
    [
      "emoji",
      "/v",
      "🚀.py",
      "http://127.0.0.1:5555/?tkn=tok123&folder=%2Fv&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2F127.0.0.1%3A5555%2Fv%2F%25F0%259F%259A%2580.py%22%5D%5D",
    ],
  ];

  it.each(cases)("%s", (_name, root, rel, expected) => {
    expect(buildFileUrl(BASE, root, rel, TOKEN)).toBe(expected);
  });

  it("round-trips the exact non-ASCII spike path back to the same file", () => {
    const rel = "Mock Exams/scripts/estimaté tïme 文件.py";
    const root = "/Users/dan/My Vault #1";
    const url = new URL(buildFileUrl(BASE, root, rel, TOKEN));
    expect(url.searchParams.get("folder")).toBe(root);
    const payload = JSON.parse(url.searchParams.get("payload") as string) as string[][];
    expect(payload[0][0]).toBe("openFile");
    const uri = new URL(payload[0][1]);
    expect(uri.protocol).toBe("vscode-remote:");
    expect(uri.host).toBe("127.0.0.1:5555");
    expect(decodeURIComponent(uri.pathname)).toBe(`${root}/${rel}`);
    // no raw space, '#' or '?' leaks into the URI path
    expect(payload[0][1]).not.toMatch(/[ #]/);
    expect(payload[0][1].split("?")).toHaveLength(1);
  });
});

describe("normalizeLine (the line argument)", () => {
  it.each([
    [1, 1],
    [5, 5],
    [42.9, 42],
    ["7", 7],
    [" 7 ", 7],
    ["7.5", 7],
    [999999999, 999999999], // past the end of a file: kept, Go to Line puts the cursor on the last line
    [0, 1],
    [-3, 1],
    [-0.5, 1],
    ["0", 1],
    ["-2", 1],
    ["abc", 1],
    ["", 1],
    ["  ", 1],
    ["5; alert(1)", 1],
    [NaN, 1],
    [Infinity, 1],
    [-Infinity, 1],
    [null, 1],
    [undefined, 1],
    [{}, 1],
    [[], 1],
    [true, 1],
  ])("%j -> line %i", (value, expected) => {
    expect(normalizeLine(value)).toBe(expected);
  });

  it("is always a whole number of 1 or more, whatever it is given", () => {
    for (const v of [Number.MAX_VALUE, 1e300, Number.MIN_VALUE, 2 ** 53, -(2 ** 53)]) {
      const n = normalizeLine(v);
      expect(Number.isSafeInteger(n) && n >= 1, String(v)).toBe(true);
    }
  });

  it("the line never goes into the URL: the workbench URL is the same for any line and still encodes every kind of name", () => {
    // spike S2: a line cannot travel in the openFile payload, so buildFileUrl takes none and the encoding tests above stay as they are
    const url = buildFileUrl(BASE, "/vault", "a#b?c%d/é 文 🚀.py", TOKEN);
    const payload = JSON.parse(new URL(url).searchParams.get("payload") as string) as string[][];
    expect(payload[0][1]).toBe("vscode-remote://127.0.0.1:5555/vault/a%23b%3Fc%25d/%C3%A9%20%E6%96%87%20%F0%9F%9A%80.py");
  });
});

describe("targetOfUri (the file URI the editor reports, read back)", () => {
  const AUTH = "127.0.0.1:5555";
  const ROOT = "/Users/dan/My Vault";
  const uriOf = (abs: string) => buildFileUri(`http://${AUTH}`, abs);

  it.each([
    ["plain", "a/b.py"],
    ["spaces", "My Dir/a b.py"],
    ["hash", "a#b/c.py"],
    ["question mark", "a?b/c.py"],
    ["percent", "100%/c.py"],
    ["percent escape in the name", "a%20b.py"],
    ["accents", "estimaté/tïme.py"],
    ["CJK", "文件/代码.py"],
    ["emoji", "🚀 go/a.py"],
    ["a dot file", ".eslintrc.js"],
  ])("a file in the vault with %s in its name round-trips through buildFileUri", (_name, file) => {
    expect(targetOfUri(uriOf(`${ROOT}/${file}`), AUTH, ROOT)).toEqual({ kind: "vault", file });
  });

  it("keeps the Unicode form of the name it was given (the one-tab-per-file key folds NFC and NFD later)", () => {
    const nfd = "estimaté.py".normalize("NFD");
    expect(targetOfUri(uriOf(`${ROOT}/${nfd}`), AUTH, ROOT)).toEqual({ kind: "vault", file: nfd });
  });

  it("reads VS Code's own spelling of a URI, with the colon and the accents encoded the way its URI class writes them", () => {
    expect(targetOfUri("vscode-remote://127.0.0.1:5555/Users/dan/My%20Vault/t%C3%A9st/a%20b.py", AUTH, ROOT)).toEqual({ kind: "vault", file: "tést/a b.py" });
  });

  it.each([
    ["an absolute path elsewhere", "/etc/hosts", "/etc/hosts"],
    ["a node_modules type definition outside the vault", "/usr/lib/node_modules/typescript/lib/lib.d.ts", "/usr/lib/node_modules/typescript/lib/lib.d.ts"],
    ["a sibling folder that shares the vault's name as a prefix", "/Users/dan/My Vault 2/a.py", "/Users/dan/My Vault 2/a.py"],
    ["the vault folder itself", "/Users/dan/My Vault", "/Users/dan/My Vault"],
    ["a path above the vault root", "/Users/dan/My Vault/../secret.txt", "/Users/dan/secret.txt"],
    ["a path that climbs out and back in another folder", "/Users/dan/My Vault/a/../../other/x.py", "/Users/dan/other/x.py"],
  ])("%s is outside the vault", (_name, abs, resolved) => {
    expect(targetOfUri(`vscode-remote://${AUTH}${abs.split("/").map(encodeURIComponent).join("/")}`, AUTH, ROOT)).toEqual({ kind: "outside", path: resolved });
  });

  it("a path that wanders inside the vault is the vault file it resolves to", () => {
    expect(targetOfUri(uriOf(`${ROOT}/a/../b/./c.py`), AUTH, ROOT)).toEqual({ kind: "vault", file: "b/c.py" });
  });

  it("an encoded slash cannot smuggle a .. past the vault root (the URL parser leaves %2F alone, so the .. is resolved here)", () => {
    const encoded = (rest: string) => `vscode-remote://${AUTH}/Users/dan/My%20Vault${rest}`;
    expect(targetOfUri(encoded("%2F..%2Fsecret.txt"), AUTH, ROOT)).toEqual({ kind: "outside", path: "/Users/dan/secret.txt" });
    expect(targetOfUri(encoded("%2Fa%2F..%2F..%2F..%2Fetc%2Fhosts"), AUTH, ROOT)).toEqual({ kind: "outside", path: "/Users/etc/hosts" });
    expect(targetOfUri(encoded("%2Fa%2F..%2Fb%2F.%2Fc.py"), AUTH, ROOT)).toEqual({ kind: "vault", file: "b/c.py" });
  });

  it("a vault at the file system root has every path inside it", () => {
    expect(targetOfUri(uriOf("/a/b.py"), AUTH, "/")).toEqual({ kind: "vault", file: "a/b.py" });
    expect(targetOfUri(uriOf("/a/b.py"), AUTH, "")).toEqual({ kind: "vault", file: "a/b.py" });
  });

  it.each([
    ["another server", "vscode-remote://127.0.0.1:9999/Users/dan/My%20Vault/a.py"],
    ["another host", "vscode-remote://example.com:5555/Users/dan/My%20Vault/a.py"],
    ["another scheme", "file:///Users/dan/My%20Vault/a.py"],
    ["the user data scheme", "vscode-userdata://127.0.0.1:5555/User/settings.json"],
    ["an untitled file", "untitled:Untitled-1"],
    ["not a URI", "not a uri"],
    ["empty", ""],
    ["a stray percent", "vscode-remote://127.0.0.1:5555/Users/dan/My%20Vault/100%/a.py"],
  ])("%s is not a file of this server", (_name, uri) => {
    expect(targetOfUri(uri, AUTH, ROOT)).toEqual({ kind: "other" });
  });
});
