import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs helper shared with the render check, no type declarations
import { classifyMarketplaceRequests } from "../render/marketplace-requests.mjs";

type Req = { method?: string; url: string };
const classify = classifyMarketplaceRequests as (r: Req[]) => { queries: number; unexpected: string[] };

describe("F4 marketplace request match (tests/render/chrome-spike-check.mjs)", () => {
  const QUERY = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";

  it("counts the one allowed extensionquery POST and reports nothing unexpected", () => {
    expect(classify([{ method: "POST", url: QUERY }])).toEqual({ queries: 1, unexpected: [] });
  });

  it("counts every extensionquery POST, and lets the CORS preflight of that path through", () => {
    expect(classify([{ method: "OPTIONS", url: QUERY }, { method: "POST", url: QUERY }, { method: "POST", url: `${QUERY}?x=1` }])).toEqual({ queries: 2, unexpected: [] });
  });

  it("flags the per-extension latest lookups the seeded settings switch off, even though the host is known", () => {
    const latest = "https://marketplace.visualstudio.com/_apis/public/gallery/vscode/ms-python/python/latest";
    expect(classify([{ method: "GET", url: latest }, { method: "POST", url: QUERY }])).toEqual({ queries: 1, unexpected: ["GET /_apis/public/gallery/vscode/ms-python/python/latest"] });
  });

  it("flags the allowed path with another method, and ignores other hosts and non-URLs", () => {
    expect(classify([{ method: "GET", url: QUERY }, { method: "GET", url: "http://127.0.0.1:1/x" }, { method: "GET", url: "data:text/plain,hi" }])).toEqual({ queries: 0, unexpected: ["GET /_apis/public/gallery/extensionquery"] });
  });

  it("treats a request with no method as a GET", () => {
    expect(classify([{ url: QUERY }]).unexpected).toEqual(["GET /_apis/public/gallery/extensionquery"]);
  });
});
