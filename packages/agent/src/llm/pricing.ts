import type { TokenUsage } from "../trace.js";

/**
 * USD per million tokens (base rates, no caching or batch discounts).
 * Source: platform.claude.com/docs/en/models/overview, checked 2026-11-12.
 * Thinking tokens are billed as output and included in outputTokens.
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-fable-5-2": { input: 8, output: 40 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
};

/** Cost in USD, or undefined for a model without a known price. */
export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
): number | undefined {
  const price = PRICES_PER_MTOK[model];
  if (!price) return undefined;
  return (
    (usage.inputTokens * price.input + usage.outputTokens * price.output) /
    1_000_000
  );
}
