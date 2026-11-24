import { describe, expect, it } from "vitest";
import {
  accessibleNameMatcher,
  cleanAccessibleName,
  cleanSnapshotNames,
} from "./names.js";

describe("cleanAccessibleName", () => {
  it("removes icon-font glyphs and extra whitespace", () => {
    expect(cleanAccessibleName("\uf090 Login")).toBe("Login");
    expect(cleanAccessibleName("Save\uf0c7  draft ")).toBe("Save draft");
    expect(cleanAccessibleName("Login")).toBe("Login");
  });
});

describe("accessibleNameMatcher", () => {
  it("matches the exact name, with or without icon glyphs", () => {
    const matcher = accessibleNameMatcher("Login");
    expect(matcher.test("Login")).toBe(true);
    expect(matcher.test("\uf090 Login")).toBe(true);
    expect(matcher.test(" Login \uf090")).toBe(true);
  });

  it("is still exact: no substrings, case-sensitive", () => {
    const matcher = accessibleNameMatcher("Login");
    expect(matcher.test("Login now")).toBe(false);
    expect(matcher.test("login")).toBe(false);
    expect(accessibleNameMatcher("Log").test("Login")).toBe(false);
  });

  it("escapes regex characters in names", () => {
    const matcher = accessibleNameMatcher("Test.allTheThings() T-Shirt (Red)");
    expect(matcher.test("Test.allTheThings() T-Shirt (Red)")).toBe(true);
    expect(matcher.test("TestXallTheThings() T-Shirt (Red)")).toBe(false);
  });

  it("matches only unnamed elements for an empty name", () => {
    expect(accessibleNameMatcher("").test("")).toBe(true);
    expect(accessibleNameMatcher("").test("Option 1")).toBe(false);
  });
});

describe("cleanSnapshotNames", () => {
  it("cleans names in role lines and leaves everything else", () => {
    const snapshot = [
      '- heading "Login Page" [level=2]',
      '  - button "\uf090 Login"',
      "  - text: \uf090 icon in plain text stays",
    ].join("\n");

    expect(cleanSnapshotNames(snapshot)).toBe(
      [
        '- heading "Login Page" [level=2]',
        '  - button "Login"',
        "  - text: \uf090 icon in plain text stays",
      ].join("\n"),
    );
  });
});
