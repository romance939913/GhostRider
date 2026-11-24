import { describe, expect, it } from "vitest";
import { ARIA_ROLE_LIST } from "../roles.js";
import type { ActionType } from "../trace.js";
import { AGENT_TOOLS, parseToolCall } from "./tools.js";

/** Keywords strict tool use rejects; the Zod schema checks these instead. */
const UNSUPPORTED_KEYWORDS = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "oneOf",
];

/** Every object-typed (sub)schema inside a schema. */
function objectSchemas(schema: unknown): Record<string, unknown>[] {
  if (Array.isArray(schema)) return schema.flatMap(objectSchemas);
  if (typeof schema !== "object" || schema === null) return [];
  const record = schema as Record<string, unknown>;
  const nested = Object.values(record).flatMap(objectSchemas);
  return record.type === "object" ? [record, ...nested] : nested;
}

function allKeys(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(allKeys);
  if (typeof schema !== "object" || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) => [
    key,
    ...allKeys(value),
  ]);
}

describe("AGENT_TOOLS", () => {
  it("has exactly one tool per action type", () => {
    // Record<ActionType, true> fails to compile if an action type is missing.
    const expected: Record<ActionType, true> = {
      navigate: true,
      click: true,
      select: true,
      type: true,
      assert: true,
      done: true,
    };
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual(
      Object.keys(expected).sort(),
    );
  });

  describe.each(AGENT_TOOLS.map((t) => [t.name, t] as const))(
    "%s",
    (_name, tool) => {
      it("closes every object with additionalProperties: false", () => {
        for (const schema of objectSchemas(tool.inputSchema)) {
          expect(schema.additionalProperties).toBe(false);
        }
      });

      it("only requires properties it defines", () => {
        for (const schema of objectSchemas(tool.inputSchema)) {
          const properties = Object.keys(
            (schema.properties as Record<string, unknown>) ?? {},
          );
          for (const required of (schema.required as string[]) ?? []) {
            expect(properties).toContain(required);
          }
        }
      });

      it("uses no keywords that strict tool use rejects", () => {
        const keys = allKeys(tool.inputSchema);
        for (const keyword of UNSUPPORTED_KEYWORDS) {
          expect(keys).not.toContain(keyword);
        }
      });

      it("asks for thought and intent first", () => {
        expect(Object.keys(tool.inputSchema.properties).slice(0, 2)).toEqual([
          "thought",
          "intent",
        ]);
        expect(tool.inputSchema.required).toEqual(
          expect.arrayContaining(["thought", "intent"]),
        );
      });
    },
  );

  it("limits element roles to real ARIA roles", () => {
    const click = AGENT_TOOLS.find((t) => t.name === "click");
    const target = click?.inputSchema.properties.target as {
      properties: { role: { enum: readonly string[] } };
    };
    expect(target.properties.role.enum).toEqual(ARIA_ROLE_LIST);
  });
});

describe("parseToolCall", () => {
  const base = { thought: "The login form is visible.", intent: "Click Login" };

  it("turns a click into a decision, without thought/intent in the action", () => {
    const result = parseToolCall("click", {
      ...base,
      target: { role: "button", name: "Login" },
    });

    expect(result).toEqual({
      ok: true,
      decision: {
        thought: "The login form is visible.",
        intent: "Click Login",
        action: { type: "click", target: { role: "button", name: "Login" } },
      },
    });
  });

  it("parses each assertion kind", () => {
    for (const assertion of [
      { kind: "textVisible", text: "Products" },
      { kind: "elementVisible", target: { role: "heading", name: "Products" } },
      {
        kind: "fieldValue",
        target: { role: "combobox", name: "Size" },
        value: "Large",
      },
      { kind: "urlMatches", pattern: "/inventory\\.html$" },
    ]) {
      expect(parseToolCall("assert", { ...base, assertion }).ok).toBe(true);
    }
  });

  it("rejects an unknown tool", () => {
    expect(parseToolCall("hover", base)).toEqual({
      ok: false,
      message: 'Unknown tool "hover".',
    });
  });

  it("rejects an empty intent", () => {
    const result = parseToolCall("done", {
      ...base,
      intent: "  ",
      success: true,
      summary: "Done",
    });
    expect(result).toMatchObject({ ok: false });
  });

  it("rejects input that fails the trace schema (bad regex)", () => {
    const result = parseToolCall("assert", {
      ...base,
      assertion: { kind: "urlMatches", pattern: "(" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("regular expression");
  });

  it("rejects a missing required argument", () => {
    const result = parseToolCall("type", {
      ...base,
      target: { role: "textbox", name: "Username" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("text");
  });

  it("rejects non-object input", () => {
    expect(parseToolCall("click", "button Login").ok).toBe(false);
  });
});
