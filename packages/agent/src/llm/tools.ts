import { Action, type ActionType } from "@ghostrider/shared";
import { ARIA_ROLE_LIST } from "../roles.js";
import type { AgentDecision } from "./types.js";

/**
 * Tool definitions for the agent, one per action type, as plain JSON Schema
 * so any provider adapter can use them.
 *
 * The schemas stay within what strict tool use supports: every object sets
 * `additionalProperties: false`, and there are no `minLength` / `minimum`
 * style constraints (unsupported). Those finer checks happen afterwards,
 * when the input is validated against the trace's Zod `Action` schema.
 *
 * Every tool starts with `thought` and `intent`, so the model explains the
 * step before choosing its arguments, and every trace step gets both.
 */

// A type alias, not an interface: the SDK's input_schema type has an index
// signature, which interfaces can't satisfy implicitly.
export type ToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

export interface ToolDefinition {
  name: ActionType;
  description: string;
  inputSchema: ToolInputSchema;
}

const thought = {
  type: "string",
  description:
    "One or two sentences: what you see on the page and why this is the right next step.",
};

const intent = {
  type: "string",
  description:
    'What this step does, as a short imperative for a human reader, e.g. "Click the Login button". Shown in alerts if this step breaks later.',
};

const target = {
  type: "object",
  description:
    "The element, exactly as it appears in the snapshot: its role and its accessible name.",
  properties: {
    role: {
      type: "string",
      enum: ARIA_ROLE_LIST,
      description: 'ARIA role from the snapshot, e.g. "button".',
    },
    name: {
      type: "string",
      description:
        'Accessible name, copied exactly from the snapshot (the quoted text), e.g. "Login".',
    },
    nth: {
      type: "integer",
      description:
        "Only when several elements share this role and name: 0-based position in snapshot order.",
    },
  },
  required: ["role", "name"],
  additionalProperties: false,
};

function tool(
  name: ActionType,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { thought, intent, ...properties },
      required: ["thought", "intent", ...required],
      additionalProperties: false,
    },
  };
}

export const AGENT_TOOLS: readonly ToolDefinition[] = [
  tool(
    "navigate",
    "Go to a URL. Prefer clicking links; navigate only when the goal names a URL or you need to start over.",
    { url: { type: "string", format: "uri", description: "Absolute URL." } },
    ["url"],
  ),
  tool(
    "click",
    "Click an element: a button, link, checkbox, tab, menu item, etc.",
    { target },
    ["target"],
  ),
  tool(
    "select",
    "Choose an option in a native dropdown: a combobox or listbox whose options are listed under it in the snapshot. Clicking those options doesn't work; use this instead.",
    {
      target,
      option: {
        type: "string",
        description: 'The option\'s label exactly as shown, e.g. "Option 2".',
      },
    },
    ["target", "option"],
  ),
  tool(
    "type",
    "Replace the contents of a text field. For secrets, type the placeholder, e.g. {{secrets.password}}.",
    {
      target,
      text: { type: "string", description: "Text to enter." },
      submit: {
        type: "boolean",
        description: "Press Enter afterwards, e.g. to submit a search.",
      },
    },
    ["target", "text"],
  ),
  tool(
    "assert",
    'Check that the page is in an expected state. Assertions become the checks GhostRider runs on a schedule, so each one must be meaningful and stable: assert the specific outcome the goal names ("1 item left", not "item left"), using headings, confirmation messages or URLs, never timestamps or personalized content. One assert that proves the goal is usually enough.',
    {
      assertion: {
        anyOf: [
          {
            type: "object",
            description: "This text is visible somewhere on the page.",
            properties: {
              kind: { type: "string", const: "textVisible" },
              text: { type: "string" },
            },
            required: ["kind", "text"],
            additionalProperties: false,
          },
          {
            type: "object",
            description: "An element with this role and name is visible.",
            properties: {
              kind: { type: "string", const: "elementVisible" },
              target,
            },
            required: ["kind", "target"],
            additionalProperties: false,
          },
          {
            type: "object",
            description:
              "A text field contains exactly this value, or a native dropdown has this option selected (by label). Use this to verify form fields and dropdowns: options inside a closed dropdown are not visible.",
            properties: {
              kind: { type: "string", const: "fieldValue" },
              target,
              value: { type: "string" },
            },
            required: ["kind", "target", "value"],
            additionalProperties: false,
          },
          {
            type: "object",
            description:
              "The current URL matches this regular expression (JavaScript syntax).",
            properties: {
              kind: { type: "string", const: "urlMatches" },
              pattern: { type: "string" },
            },
            required: ["kind", "pattern"],
            additionalProperties: false,
          },
        ],
      },
    },
    ["assertion"],
  ),
  tool(
    "done",
    "Finish the recording. success: true only after an assert has confirmed the goal. success: false if the goal can't be achieved (site error, missing feature, blocked by a login you have no credentials for).",
    {
      success: { type: "boolean" },
      summary: {
        type: "string",
        description: "One or two sentences on what happened.",
      },
    },
    ["success", "summary"],
  ),
];

export type ParsedToolCall =
  | { ok: true; decision: AgentDecision }
  | { ok: false; message: string };

/**
 * Turns a tool call from the model into an AgentDecision, validating it
 * against the trace schema. Strict tool use already guarantees the JSON
 * shape; this adds the checks JSON Schema can't express (non-empty intent,
 * valid URL, compilable regex, ...) and guards against non-strict providers.
 */
export function parseToolCall(name: string, input: unknown): ParsedToolCall {
  if (!AGENT_TOOLS.some((t) => t.name === name)) {
    return { ok: false, message: `Unknown tool "${name}".` };
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: `Tool "${name}" input must be an object.` };
  }

  const { thought, intent, ...args } = input as Record<string, unknown>;
  if (typeof intent !== "string" || intent.trim() === "") {
    return { ok: false, message: "intent must be a non-empty string." };
  }

  const parsed = Action.safeParse({ type: name, ...args });
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || name}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `Invalid ${name} input: ${problems}` };
  }

  return {
    ok: true,
    decision: {
      thought: typeof thought === "string" ? thought : "",
      intent: intent.trim(),
      action: parsed.data,
    },
  };
}
