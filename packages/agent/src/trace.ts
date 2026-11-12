import { z } from "zod";

/**
 * Trace format v0: the agent's step-by-step record of a journey.
 *
 * Provisional until the end of M1 (ADR-005), when it moves to
 * packages/shared and a new ADR locks it. Bump TRACE_FORMAT_VERSION on any
 * breaking change so stored traces stay readable.
 */
export const TRACE_FORMAT_VERSION = 0;

const NonNegativeInt = z.int().min(0);

// ---------------------------------------------------------------------------
// Targets: how the agent points at an element
// ---------------------------------------------------------------------------

/**
 * An element identified by ARIA role + accessible name, exactly what
 * Playwright's `getByRole(role, { name, exact: true })` takes. Using this as
 * the agent's only way to target elements means the trace already contains
 * the stable selector the compiler (M2) needs.
 */
export const ElementTarget = z.object({
  /** ARIA role as shown in the snapshot, e.g. "button", "textbox", "link". */
  role: z.string().min(1),
  /** Accessible name, matched exactly, e.g. "Login". */
  name: z.string(),
  /** 0-based index when several elements share the same role + name. */
  nth: NonNegativeInt.optional(),
});
export type ElementTarget = z.infer<typeof ElementTarget>;

// ---------------------------------------------------------------------------
// Actions: the agent's tool calls
// ---------------------------------------------------------------------------

export const Assertion = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("textVisible"), text: z.string().min(1) }),
  z.object({ kind: z.literal("elementVisible"), target: ElementTarget }),
  z.object({
    kind: z.literal("urlMatches"),
    /** Regular expression source, tested against the full URL. */
    pattern: z
      .string()
      .min(1)
      .refine(isValidRegExp, "pattern must be a valid regular expression"),
  }),
]);
export type Assertion = z.infer<typeof Assertion>;

export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.url() }),
  z.object({ type: z.literal("click"), target: ElementTarget }),
  z.object({
    type: z.literal("type"),
    target: ElementTarget,
    /** May contain placeholders like {{secrets.password}}; never the secret itself. */
    text: z.string(),
    /** Press Enter after typing. */
    submit: z.boolean().optional(),
  }),
  z.object({ type: z.literal("assert"), assertion: Assertion }),
  z.object({
    type: z.literal("done"),
    /** The agent's own verdict on whether the goal was achieved. */
    success: z.boolean(),
    summary: z.string(),
  }),
]);
export type Action = z.infer<typeof Action>;
export type ActionType = Action["type"];

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** What the agent saw before choosing the step's action. */
export const TraceObservation = z.object({
  url: z.url(),
  title: z.string(),
  /** The snapshot actually sent to the model (after any trimming). */
  snapshot: z.string(),
  /** Length of the untrimmed snapshot, in characters. */
  snapshotChars: NonNegativeInt,
  /** True when the snapshot was trimmed to fit the token budget. */
  truncated: z.boolean(),
});
export type TraceObservation = z.infer<typeof TraceObservation>;

export const StepErrorCode = z.enum([
  "element_not_found",
  "ambiguous_target",
  "timeout",
  "navigation_failed",
  "assertion_failed",
  "invalid_action",
]);
export type StepErrorCode = z.infer<typeof StepErrorCode>;

export const StepResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    durationMs: NonNegativeInt,
    /** Page URL after the action, to spot navigations. */
    urlAfter: z.url(),
  }),
  z.object({
    ok: z.literal(false),
    durationMs: NonNegativeInt,
    error: z.object({ code: StepErrorCode, message: z.string() }),
  }),
]);
export type StepResult = z.infer<typeof StepResult>;

export const TokenUsage = z.object({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const TraceStep = z.object({
  /** 0-based position in the trace. */
  index: NonNegativeInt,
  observation: TraceObservation,
  /** The model's free-form reasoning. For debugging; never shown in alerts. */
  thought: z.string(),
  /**
   * One short English line describing what the step does, e.g.
   * "Click the Login button". Stored on every compiled step and used in
   * alerts ("couldn't click the Login button").
   */
  intent: z.string().min(1),
  action: Action,
  result: StepResult,
  usage: TokenUsage,
});
export type TraceStep = z.infer<typeof TraceStep>;

// ---------------------------------------------------------------------------
// Trace
// ---------------------------------------------------------------------------

export const TraceOutcomeStatus = z.enum([
  /** Agent called done(success: true). */
  "succeeded",
  /** Agent called done(success: false): it decided the goal can't be achieved. */
  "failed",
  /** Hit the maximum number of steps. */
  "step_limit",
  /** Hit the token / cost budget. */
  "budget_exceeded",
  /** GhostRider's own fault: browser crash, LLM API error, etc. */
  "error",
]);
export type TraceOutcomeStatus = z.infer<typeof TraceOutcomeStatus>;

export const Trace = z
  .object({
    traceFormatVersion: z.literal(TRACE_FORMAT_VERSION),
    id: z.uuid(),
    goal: z.string().min(1),
    startUrl: z.url(),
    model: z.object({ provider: z.string().min(1), name: z.string().min(1) }),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    outcome: z.object({ status: TraceOutcomeStatus, summary: z.string() }),
    steps: z.array(TraceStep),
    totals: TokenUsage.extend({ costUsd: z.number().nonnegative().optional() }),
  })
  .superRefine((trace, ctx) => {
    trace.steps.forEach((step, i) => {
      if (step.index !== i) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", i, "index"],
          message: `expected index ${i}, got ${step.index}`,
        });
      }
    });

    // "succeeded" must be backed by the agent's own done(success: true).
    const last = trace.steps.at(-1);
    const endsWithSuccessfulDone =
      last?.action.type === "done" && last.action.success;
    if (trace.outcome.status === "succeeded" && !endsWithSuccessfulDone) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome", "status"],
        message:
          'a "succeeded" trace must end with a done action where success is true',
      });
    }
  });
export type Trace = z.infer<typeof Trace>;

function isValidRegExp(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}
