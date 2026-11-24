import Anthropic from "@anthropic-ai/sdk";
import { estimateCostUsd } from "./pricing.js";
import { renderUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { AGENT_TOOLS, parseToolCall } from "./tools.js";
import type {
  LlmClient,
  NextActionRequest,
  NextActionResult,
} from "./types.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

/** Thinking counts toward max_tokens, so leave room beyond the tool call. */
const DEFAULT_MAX_TOKENS = 8_192;

const ANTHROPIC_TOOLS: Anthropic.Tool[] = AGENT_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
  strict: true,
}));

/** The one SDK method we use, so tests can pass a fake. */
export interface AnthropicMessagesApi {
  create(
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message>;
}

export interface AnthropicLlmOptions {
  model?: string;
  maxTokens?: number;
  /** Defaults to the ANTHROPIC_API_KEY environment variable. */
  apiKey?: string;
  /** Inject a fake in tests; defaults to the real SDK client. */
  messages?: AnthropicMessagesApi;
}

/**
 * Picks the next action with Claude, using strict tool use.
 *
 * Each call is a single, stateless request: the full context (goal, a
 * summary of earlier steps, the current page) is rebuilt every time rather
 * than growing a conversation. Old page snapshots are never re-sent, so cost
 * per step stays flat as the journey gets longer.
 *
 * Current models (Sonnet 5.5 and up) reject forced tool choice ("any" /
 * "tool") and custom temperature, so this uses tool_choice "auto" with
 * strict tools, and handles a text-only reply as a recoverable error.
 */
export class AnthropicLlm implements LlmClient {
  readonly provider = "anthropic";
  readonly model: string;
  private readonly maxTokens: number;
  private readonly messages: AnthropicMessagesApi;

  constructor(options: AnthropicLlmOptions = {}) {
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.messages =
      options.messages ?? new Anthropic({ apiKey: options.apiKey }).messages;
  }

  async nextAction(request: NextActionRequest): Promise<NextActionResult> {
    const response = await this.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      // Cache breakpoint on the system prompt: caches tools + system, which
      // are identical on every step. Not top-level automatic caching, which
      // would also cache the per-step page snapshot and never reuse it.
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: ANTHROPIC_TOOLS,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages: [{ role: "user", content: renderUserPrompt(request) }],
    });

    // The API's input_tokens excludes cached tokens; ours is the total.
    const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;
    const usage = {
      inputTokens:
        response.usage.input_tokens + cacheReadTokens + cacheWriteTokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
    const costUsd = estimateCostUsd(this.model, usage);

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (!toolUse) {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join(" ")
        .trim();
      return {
        ok: false,
        usage,
        costUsd,
        error: {
          code: "no_tool_call",
          message: `Replied without calling a tool (stop_reason: ${response.stop_reason})${text ? `: ${text.slice(0, 300)}` : ""}. Call exactly one tool.`,
        },
      };
    }

    const parsed = parseToolCall(toolUse.name, toolUse.input);
    if (!parsed.ok) {
      return {
        ok: false,
        usage,
        costUsd,
        error: { code: "invalid_tool_call", message: parsed.message },
      };
    }
    return { ok: true, usage, costUsd, decision: parsed.decision };
  }
}
