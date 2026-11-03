/**
 * The F4 marketplace check of the chrome spike (tests/render/chrome-spike-check.mjs), kept apart so a unit test can call it.
 *
 * docs/spike-decision.md allows exactly one kind of request to marketplace.visualstudio.com: the `POST
 * /_apis/public/gallery/extensionquery` the workbench's chat feature sends for the single extension id `github.copilot-chat`.
 * The per-extension `GET /_apis/public/gallery/vscode/<publisher>/<name>/latest` lookups that the seeded settings switch off are
 * NOT allowed, so a host-level comparison is not enough: this matches the method and the path. A CORS preflight (`OPTIONS`) of the
 * allowed path is allowed too.
 */
export const MARKETPLACE_HOST = "marketplace.visualstudio.com";
export const ALLOWED_MARKETPLACE_PATH = "/_apis/public/gallery/extensionquery";

/**
 * @param {{ method?: string, url: string }[]} requests every request the browser sent (any host is fine; others are ignored)
 * @returns {{ queries: number, unexpected: string[] }} `queries` counts the allowed extensionquery POSTs; `unexpected` lists
 *   every other marketplace request as "METHOD /path", in the order seen.
 */
export function classifyMarketplaceRequests(requests) {
  let queries = 0;
  const unexpected = [];
  for (const r of requests) {
    let u;
    try { u = new URL(r.url); } catch { continue; } // data: urls and the like
    if (u.hostname !== MARKETPLACE_HOST) continue;
    const method = (r.method ?? "GET").toUpperCase();
    if (u.pathname === ALLOWED_MARKETPLACE_PATH && method === "POST") queries++;
    else if (u.pathname === ALLOWED_MARKETPLACE_PATH && method === "OPTIONS") continue;
    else unexpected.push(`${method} ${u.pathname}`);
  }
  return { queries, unexpected };
}
