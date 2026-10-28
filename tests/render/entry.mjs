/**
 * Runs in the browser page. Shows one scenario with the plugin's own code (the real ChoiceModal and its
 * prompts: promptReuseBuild, and the unsaved-changes prompts of the Code tabs; the Notice text is passed in
 * from describeFailure), then measures the rendered DOM and
 * writes the result as JSON into <pre id="result">.
 */
import { Notice } from "./obsidian-shim.mjs";
import { promptReuseBuild, promptCloseDirty, promptSaveOrDiscard, promptSaveFailed, promptRestartWithDirty } from "../../src/modals";
import { renderExtensionsSection } from "../../src/settings/extensions-section";

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

/** Open the prompt a scenario names, with the plugin's own modal code. */
function openPrompt(sc) {
  switch (sc.prompt ?? "reuse-build") {
    case "reuse-build":
      return promptReuseBuild({}, sc.change);
    case "close-dirty":
      return promptCloseDirty({}, sc.request);
    case "quit-save-or-discard":
      return promptSaveOrDiscard({}, sc.files);
    case "quit-save-failed":
      return promptSaveFailed({}, sc.files);
    case "restart-with-dirty":
      return promptRestartWithDirty({}, sc.files);
    default:
      throw new Error(`unknown prompt ${sc.prompt}`);
  }
}

async function run(scenario) {
  const out = { scenario, window: `${window.innerWidth}x${window.innerHeight}`, results: [] };
  if (scenario.kind === "notice") {
    new Notice(scenario.message, 15000);
    out.results.push(measure(document.querySelector(".notice"), "notice"));
    out.results.push(measure(document.querySelector(".notice-container"), "notice-container"));
  } else if (scenario.kind === "settings-section") {
    // The Extensions section of the settings tab, drawn by the plugin's own renderer from a view built in node.
    // Settings scrolls, so the section may be taller than the window; the Profile row is scrolled into view and
    // measured (text lines against the window width and any clipping ancestor), as a reader would see it.
    const holder = document.body.createDiv({ cls: "workbench-render-settings" });
    renderExtensionsSection(holder, scenario.view);
    const profileRow = [...holder.querySelectorAll(".workbench-extensions-row")].find((r) => r.firstChild?.textContent === "Profile");
    if (!profileRow) throw new Error("no Profile row in the Extensions section");
    profileRow.scrollIntoView({ block: "center" });
    out.results.push(measure(profileRow, "profile-row"));
    out.profileRow = profileRow.lastChild?.textContent ?? null;
  } else {
    const answer = openPrompt(scenario);
    void answer;
    out.results.push(measure(document.querySelector(".modal"), "modal"));
    const buttons = [...document.querySelectorAll(".modal button")].map((b) => b.textContent);
    out.buttons = buttons;
  }
  out.ok = out.results.every((r) => r.ok);
  return out;
}

export { run };
