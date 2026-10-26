import { describe, expect, it } from "vitest";
import { authorityOf, buildFileUri, buildFileUrl, buildFolderUrl, encodePathSegments, toAbsolutePath } from "../../src/paths";

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
