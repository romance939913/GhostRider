import type { TokenUsage } from "../trace.js";

interface Price {
  /** USD per million uncached input tokens. */
  input: number;
  /** USD per million output tokens (thinking included). */
  output: number;
  /** Cache read price as a fraction of the input price. */
  cacheReadMultiplier: number;
}

/**
 * Base rates (no batch discount). Sources, checked 2026-11-24:
 * platform.claude.com/docs/en/models/overview and
 * platform.claude.com/docs/en/build-with-claude/prompt-caching.
 */
const PRICES: Record<string, Price> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheReadMultiplier: 0.025 },
  "claude-opus-5-5": { input: 4, output: 20, cacheReadMultiplier: 0.05 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheReadMultiplier: 0.05 },
};

/** 5-minute cache writes cost 1.25× the input price. */
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Cost in USD, or undefined for a model without a known price. */
export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
): number | undefined {
  const price = PRICES[model];
  if (!price) return undefined;

  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const uncached = usage.inputTokens - cacheRead - cacheWrite;

  const inputCost =
    uncached * price.input +
    cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
    cacheRead * price.input * price.cacheReadMultiplier;
  return (inputCost + usage.outputTokens * price.output) / 1_000_000;
}
