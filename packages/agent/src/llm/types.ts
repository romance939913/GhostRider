import type {
  Action,
  StepResult,
  TokenUsage,
  TraceObservation,
} from "../trace.js";

/** One earlier step, as the model sees it in the prompt. */
export interface HistoryEntry {
  intent: string;
  action: Action;
  result: StepResult;
}

/** Everything the model needs to choose the next action. */
export interface NextActionRequest {
  goal: string;
  startUrl: string;
  observation: TraceObservation;
  /** Steps taken so far, oldest first. */
  history: HistoryEntry[];
  /** Names only. The model refers to secrets as {{secrets.<name>}}. */
  secretNames: string[];
  /** Correction for a previous bad response, e.g. "you didn't call a tool". */
  feedback?: string;
}

/** The model's choice for one step. */
export interface AgentDecision {
  /** Brief reasoning. For debugging; never shown in alerts. */
  thought: string;
  /** One short English line, e.g. "Click the Login button". */
  intent: string;
  action: Action;
}

export type LlmErrorCode =
  /** Answered in text instead of calling a tool. */
  | "no_tool_call"
  /** Called a tool, but the input failed validation. */
  | "invalid_tool_call";

interface LlmResultBase {
  usage: TokenUsage;
  /** Undefined when the model's price isn't known. */
  costUsd: number | undefined;
}

export type NextActionResult =
  | (LlmResultBase & { ok: true; decision: AgentDecision })
  | (LlmResultBase & {
      ok: false;
      error: { code: LlmErrorCode; message: string };
    });

/**
 * A model that picks the agent's next action. One implementation per
 * provider; the agent loop only depends on this interface (M7 compares
 * providers behind it).
 *
 * Expected model mistakes come back as `ok: false` so the loop can re-prompt
 * with `feedback`. Network and API errors throw.
 */
export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  nextAction(request: NextActionRequest): Promise<NextActionResult>;
}
