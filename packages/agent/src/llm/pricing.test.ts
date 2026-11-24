import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./pricing.js";

describe("estimateCostUsd", () => {
  it("prices uncached input, cache reads, cache writes and output", () => {
    // Sonnet 5.5: $2/M input, $2.50/M cache write, $0.10/M cache read, $10/M output
    expect(
      estimateCostUsd("claude-sonnet-5-5", {
        inputTokens: 9_000,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 4_000,
        outputTokens: 100,
      }),
    ).toBeCloseTo((1_000 * 2 + 4_000 * 2.5 + 4_000 * 0.1 + 100 * 10) / 1e6, 10);
  });

  it("treats missing cache fields as no caching", () => {
    expect(
      estimateCostUsd("claude-sonnet-5-5", {
        inputTokens: 1_000,
        outputTokens: 200,
      }),
    ).toBeCloseTo(0.004, 10);
  });

  it("returns undefined for a model without a known price", () => {
    expect(
      estimateCostUsd("some-other-model", { inputTokens: 1, outputTokens: 1 }),
    ).toBeUndefined();
  });
});
