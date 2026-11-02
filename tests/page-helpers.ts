/** Small helpers for the jsdom tests that mount the drawer on a page. */
export const tick = () => new Promise((r) => setTimeout(r, 5));

/** An empty page: no classes or inline styles on the body, nothing in it. */
export function resetPage(): void {
  document.body.className = "";
  document.body.removeAttribute("style");
  document.body.innerHTML = "";
}
