// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ShellCountItem, shellCountLabel } from "../../src/terminal/shell-count";

function item() {
  const bar = document.createElement("div");
  document.body.replaceChildren(bar);
  let made = 0;
  const it = new ShellCountItem(() => {
    made += 1;
    const el = document.createElement("div");
    bar.appendChild(el);
    return el;
  });
  return { it, bar, made: () => made };
}

describe("shellCountLabel", () => {
  it("is '1 shell' for one, '<n> shells' for more", () => {
    expect(shellCountLabel(1)).toBe("1 shell");
    expect(shellCountLabel(2)).toBe("2 shells");
    expect(shellCountLabel(10)).toBe("10 shells");
  });

  it("is null at zero and for nonsense (hidden)", () => {
    expect(shellCountLabel(0)).toBeNull();
    expect(shellCountLabel(-1)).toBeNull();
    expect(shellCountLabel(Number.NaN)).toBeNull();
  });
});

describe("ShellCountItem (G18)", () => {
  it("adds nothing while the count is zero", () => {
    const { it, bar, made } = item();
    it.update(0);
    expect(bar.children).toHaveLength(0);
    expect(made()).toBe(0);
  });

  it("shows the live count and follows it up and down in one element", () => {
    const { it, bar, made } = item();
    it.update(1);
    expect(bar.textContent).toBe("1 shell");
    it.update(2);
    expect(bar.textContent).toBe("2 shells");
    it.update(1);
    expect(bar.textContent).toBe("1 shell");
    expect(bar.children).toHaveLength(1);
    expect(made()).toBe(1);
  });

  it("is removed at zero and comes back as a fresh element", () => {
    const { it, bar, made } = item();
    it.update(2);
    it.update(0);
    expect(bar.children).toHaveLength(0);
    expect(it.element).toBeNull();
    it.update(1);
    expect(bar.children).toHaveLength(1);
    expect(made()).toBe(2);
  });

  it("dispose removes the item", () => {
    const { it, bar } = item();
    it.update(2);
    it.dispose();
    expect(bar.children).toHaveLength(0);
  });
});
