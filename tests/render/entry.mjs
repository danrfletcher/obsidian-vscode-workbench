/**
 * Runs in the browser page. Shows one offline scenario with the plugin's own code (the real ChoiceModal and
 * promptReuseBuild; the Notice text is passed in from describeFailure), then measures the rendered DOM and
 * writes the result as JSON into <pre id="result">.
 */
import { Notice } from "./obsidian-shim.mjs";
import { promptReuseBuild } from "../../src/modals";

const TOL = 0.5;

const inside = (r, box) => r.left >= box.left - TOL && r.top >= box.top - TOL && r.right <= box.right + TOL && r.bottom <= box.bottom + TOL;
const fmt = (r) => `${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}`;

/** Rects of the text actually laid out in `el` (one per line box). */
function textRects(el) {
  const rects = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    rects.push(...range.getClientRects());
  }
  return rects;
}

function measure(root, label) {
  const problems = [];
  const vp = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  const els = [root, ...root.querySelectorAll("*")];
  let lines = 0;
  for (const el of els) {
    const cs = getComputedStyle(el);
    const name = `${label}:${el.tagName.toLowerCase()}.${el.className || ""}`;
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) {
      if (el.textContent.trim() && !el.classList.contains("modal-bg") && !el.classList.contains("modal-close-button")) problems.push(`${name} is not displayed`);
      continue;
    }
    const own = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    const rects = own || el.tagName === "BUTTON" ? textRects(el) : [];
    if (own) lines += new Set(rects.map((r) => Math.round(r.top))).size;
    if (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) problems.push(`${name} is cut with an ellipsis`);
    if (cs.webkitLineClamp && cs.webkitLineClamp !== "none") problems.push(`${name} is line-clamped`);
    if (own && (cs.overflowX !== "visible" || cs.overflowY !== "visible")) {
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) problems.push(`${name} has content past its own box (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`);
    }
    for (const r of rects) {
      if (!inside(r, vp)) problems.push(`${name} text ${fmt(r)} is outside the window ${window.innerWidth}x${window.innerHeight}`);
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (acs.overflowX === "visible" && acs.overflowY === "visible") continue;
        const ar = a.getBoundingClientRect();
        if (!inside(r, ar)) problems.push(`${name} text ${fmt(r)} is clipped by ${a.className || a.tagName} ${fmt(ar)}`);
      }
    }
  }
  const box = root.getBoundingClientRect();
  return { label, box: fmt(box), textLines: lines, ok: problems.length === 0, problems };
}

async function run(scenario) {
  const out = { scenario, window: `${window.innerWidth}x${window.innerHeight}`, results: [] };
  if (scenario.kind === "notice") {
    new Notice(scenario.message, 15000);
    out.results.push(measure(document.querySelector(".notice"), "notice"));
    out.results.push(measure(document.querySelector(".notice-container"), "notice-container"));
  } else {
    const answer = promptReuseBuild({}, scenario.change);
    void answer;
    out.results.push(measure(document.querySelector(".modal"), "modal"));
    const buttons = [...document.querySelectorAll(".modal button")].map((b) => b.textContent);
    out.buttons = buttons;
  }
  out.ok = out.results.every((r) => r.ok);
  return out;
}

export { run };
