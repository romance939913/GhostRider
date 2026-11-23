import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { execute } from "./execute.js";
import type { HistoryEntry, LlmClient, NextActionResult } from "./llm/types.js";
import { observe } from "./observe.js";
import {
  type TokenUsage,
  TRACE_FORMAT_VERSION,
  Trace,
  type TraceOutcomeStatus,
  type TraceStep,
} from "./trace.js";

export const DEFAULT_MAX_STEPS = 25;
export const DEFAULT_MAX_COST_USD = 0.5;
/** Fallback budget when the model's price is unknown. */
export const DEFAULT_MAX_TOKENS = 500_000;
/** Unusable model responses in a row before giving up. */
export const DEFAULT_MAX_INVALID_RESPONSES = 3;

export interface RecordJourneyOptions {
  goal: string;
  startUrl: string;
  llm: LlmClient;
  /** Values for {{secrets.<name>}}. The model only ever sees the names. */
  secrets?: Record<string, string>;
  maxSteps?: number;
  maxCostUsd?: number;
  maxTokens?: number;
  maxInvalidResponses?: number;
  /** Snapshot budget passed to observe(). */
  budgetChars?: number;
  /** Called after every step, e.g. to print progress (M3: stream to the UI). */
  onStep?: (step: TraceStep) => void;
}

type Outcome = { status: TraceOutcomeStatus; summary: string };

/**
 * The agent loop: observe → ask the model → execute → record, until the
 * model calls done or a limit is hit.
 *
 * Always returns a Trace, including when things go wrong (LLM API error,
 * browser crash): a partial trace with outcome "error" is more useful for
 * debugging than an exception. The trace is validated against the schema
 * before it's returned.
 *
 * Guarantees, on top of what the model is told:
 * - done(success: true) is only accepted after an assert has passed, so
 *   every successful recording contains at least one real check.
 * - Unusable responses (no tool call, invalid input, early success) are
 *   re-prompted with feedback, not executed, and don't become steps.
 * - Spend is capped by step count and by cost (or tokens).
 */
export async function recordJourney(
  page: Page,
  options: RecordJourneyOptions,
): Promise<Trace> {
  const {
    goal,
    startUrl,
    llm,
    secrets = {},
    maxSteps = DEFAULT_MAX_STEPS,
    maxCostUsd = DEFAULT_MAX_COST_USD,
    maxTokens = DEFAULT_MAX_TOKENS,
    maxInvalidResponses = DEFAULT_MAX_INVALID_RESPONSES,
    budgetChars,
    onStep,
  } = options;

  const startedAt = new Date().toISOString();
  const steps: TraceStep[] = [];
  const history: HistoryEntry[] = [];
  const spend = new Spend();
  let outcome: Outcome | undefined;

  try {
    // Loading the start page isn't a decision, so it isn't a step.
    const start = await execute(page, { type: "navigate", url: startUrl });
    if (!start.ok) {
      outcome = {
        status: "failed",
        summary: `Could not load the start URL: ${start.error.message}`,
      };
    }

    let feedback: string | undefined;
    let invalidStreak = 0;
    // Usage of rejected responses is charged to the next real step.
    let pendingUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    while (!outcome) {
      if (steps.length >= maxSteps) {
        outcome = {
          status: "step_limit",
          summary: `Stopped after ${maxSteps} steps without finishing.`,
        };
        break;
      }

      const observation = await observe(page, { budgetChars, secrets });
      const response = await llm.nextAction({
        goal,
        startUrl,
        observation,
        history,
        secretNames: Object.keys(secrets),
        feedback,
      });
      spend.add(response);
      pendingUsage = addUsage(pendingUsage, response.usage);

      const rejection = !response.ok
        ? response.error.message
        : rejectEarlySuccess(response.decision.action, history);
      if (rejection !== undefined || !response.ok) {
        invalidStreak += 1;
        feedback = rejection;
        if (invalidStreak >= maxInvalidResponses) {
          outcome = {
            status: "error",
            summary: `The model returned ${invalidStreak} unusable responses in a row. Last problem: ${rejection}`,
          };
        } else {
          outcome = spend.exceeded(maxCostUsd, maxTokens);
        }
        continue;
      }
      invalidStreak = 0;
      feedback = undefined;

      const { thought, intent, action } = response.decision;
      const result = await execute(page, action, { secrets });
      const step: TraceStep = {
        index: steps.length,
        observation,
        thought,
        intent,
        action,
        result,
        usage: pendingUsage,
      };
      pendingUsage = { inputTokens: 0, outputTokens: 0 };
      steps.push(step);
      history.push({ intent, action, result });
      onStep?.(step);

      if (action.type === "done") {
        outcome = {
          status: action.success ? "succeeded" : "failed",
          summary: action.summary,
        };
      } else {
        outcome = spend.exceeded(maxCostUsd, maxTokens);
      }
    }
  } catch (error) {
    outcome = {
      status: "error",
      summary: `Recording stopped by an error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return Trace.parse({
    traceFormatVersion: TRACE_FORMAT_VERSION,
    id: randomUUID(),
    goal,
    startUrl,
    model: { provider: llm.provider, name: llm.model },
    startedAt,
    finishedAt: new Date().toISOString(),
    outcome,
    steps,
    totals: spend.totals(),
  });
}

/**
 * done(success: true) needs proof: at least one assert that passed. Without
 * it, the compiled check would verify nothing.
 */
function rejectEarlySuccess(
  action: { type: string; success?: boolean },
  history: HistoryEntry[],
): string | undefined {
  if (action.type !== "done" || action.success !== true) return undefined;
  const verified = history.some(
    (entry) => entry.action.type === "assert" && entry.result.ok,
  );
  return verified
    ? undefined
    : "You called done with success true, but no assert has passed yet. First confirm the goal with an assert on something stable (a heading, a confirmation message or the URL), then call done.";
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** Running totals across every model call, including rejected ones. */
class Spend {
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private costUsd: number | undefined = 0;

  add(response: NextActionResult): void {
    this.usage = addUsage(this.usage, response.usage);
    // One call with an unknown price makes the total unknown.
    this.costUsd =
      this.costUsd === undefined || response.costUsd === undefined
        ? undefined
        : this.costUsd + response.costUsd;
  }

  exceeded(maxCostUsd: number, maxTokens: number): Outcome | undefined {
    if (this.costUsd !== undefined && this.costUsd >= maxCostUsd) {
      return {
        status: "budget_exceeded",
        summary: `Stopped after spending $${this.costUsd.toFixed(4)} (limit $${maxCostUsd}).`,
      };
    }
    const tokens = this.usage.inputTokens + this.usage.outputTokens;
    if (tokens >= maxTokens) {
      return {
        status: "budget_exceeded",
        summary: `Stopped after ${tokens} tokens (limit ${maxTokens}).`,
      };
    }
    return undefined;
  }

  totals(): TokenUsage & { costUsd?: number } {
    return this.costUsd === undefined
      ? { ...this.usage }
      : { ...this.usage, costUsd: Math.round(this.costUsd * 1e6) / 1e6 };
  }
}
