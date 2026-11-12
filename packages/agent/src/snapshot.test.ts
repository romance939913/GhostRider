import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compactSnapshot,
  DEFAULT_SNAPSHOT_BUDGET_CHARS,
  INTERACTIVE_ROLES,
} from "./snapshot.js";

function loadSnapshot(name: string): string {
  // Real ariaSnapshot() output has no trailing newline; the saved files do.
  return readFileSync(
    new URL(`./fixtures/snapshots/${name}.aria.txt`, import.meta.url),
    "utf8",
  ).trimEnd();
}

/** Every interactive `role "name"` in a snapshot, sorted, duplicates kept. */
function interactiveElements(snapshot: string): string[] {
  const elements: string[] = [];
  for (const line of snapshot.split("\n")) {
    const match = /^\s*- ([a-z]+) "((?:[^"\\]|\\.)*)"/.exec(line);
    if (match?.[1] && INTERACTIVE_ROLES.has(match[1]))
      elements.push(`${match[1]} "${match[2]}"`);
  }
  return elements.sort();
}

const saucedemo = loadSnapshot("saucedemo-login");
const largePages = [
  ["GitHub home", loadSnapshot("github-home")],
  ["Wikipedia main page", loadSnapshot("wikipedia-main")],
] as const;

describe("compactSnapshot", () => {
  it("returns a snapshot under budget unchanged", () => {
    expect(compactSnapshot(saucedemo)).toEqual({
      snapshot: saucedemo,
      truncated: false,
    });
  });

  it("returns an empty snapshot unchanged", () => {
    expect(compactSnapshot("")).toEqual({ snapshot: "", truncated: false });
  });

  describe.each(largePages)("%s", (_name, raw) => {
    it("starts over budget (sanity check for the fixture)", () => {
      expect(raw.length).toBeGreaterThan(DEFAULT_SNAPSHOT_BUDGET_CHARS);
    });

    const result = compactSnapshot(raw);

    it("fits the budget and is marked truncated", () => {
      expect(result.snapshot.length).toBeLessThanOrEqual(
        DEFAULT_SNAPSHOT_BUDGET_CHARS,
      );
      expect(result.truncated).toBe(true);
    });

    it("keeps every interactive element", () => {
      expect(interactiveElements(result.snapshot)).toEqual(
        interactiveElements(raw),
      );
    });

    it("keeps headings", () => {
      const headings = (s: string) => s.match(/heading "[^"]*"/g) ?? [];
      expect(headings(result.snapshot)).toEqual(headings(raw));
    });

    it("drops link URLs", () => {
      expect(result.snapshot).not.toContain("/url:");
    });

    it("is idempotent", () => {
      expect(compactSnapshot(result.snapshot).snapshot).toBe(result.snapshot);
    });
  });

  it("shortens long text values but never accessible names", () => {
    const longName = "A very long link name that must survive "
      .repeat(5)
      .trim();
    const raw = [
      `- paragraph: ${"lorem ipsum ".repeat(20).trim()}`,
      `- link "${longName}":`,
      "  - /url: /somewhere",
    ].join("\n");

    const { snapshot, truncated } = compactSnapshot(raw, {
      budgetChars: raw.length - 50,
    });

    expect(truncated).toBe(true);
    expect(snapshot).toContain(`- link "${longName}"`);
    expect(snapshot).toMatch(/^- paragraph: lorem ipsum .*…$/m);
    expect(snapshot.split("\n")[0]?.length).toBeLessThan(100);
  });

  it("unwraps unnamed lists but keeps named landmarks", () => {
    const raw = [
      '- navigation "Footer":',
      "  - list:",
      ...Array.from(
        { length: 30 },
        (_, i) =>
          `    - listitem:\n      - link "Item ${i}":\n        - /url: /item/${i}`,
      ),
    ].join("\n");

    const { snapshot } = compactSnapshot(raw, { budgetChars: 700 });

    expect(snapshot).toContain('- navigation "Footer":');
    expect(snapshot).not.toContain("listitem");
    expect(interactiveElements(snapshot)).toEqual(interactiveElements(raw));
  });

  it("as a last resort keeps only interactive elements and headings, within budget", () => {
    const [, wikipedia] = largePages[1];
    const budget = 3_000;

    const { snapshot, truncated } = compactSnapshot(wikipedia, {
      budgetChars: budget,
    });

    expect(truncated).toBe(true);
    expect(snapshot.length).toBeLessThanOrEqual(budget);
    const lines = snapshot.split("\n");
    expect(lines.at(-1)).toBe("- text: … (snapshot cut to fit the budget)");
    for (const line of lines.slice(0, -1)) {
      const role = /^- ([a-z]+)/.exec(line)?.[1] ?? "";
      expect(INTERACTIVE_ROLES.has(role) || role === "heading", line).toBe(
        true,
      );
    }
    // The search box near the top of the page survives the cut.
    expect(snapshot).toContain('- searchbox "Search Wikipedia"');
  });
});
