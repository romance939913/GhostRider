import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicLlm, type AnthropicMessagesApi } from "./anthropic.js";
import type { NextActionRequest } from "./types.js";

const request: NextActionRequest = {
  goal: "Log in as standard_user",
  startUrl: "https://www.saucedemo.com/",
  observation: {
    url: "https://www.saucedemo.com/",
    title: "Swag Labs",
    snapshot: '- button "Login"',
    snapshotChars: 16,
    truncated: false,
  },
  history: [],
  secretNames: ["password"],
};

/** A fake messages API that records the request and returns `content`. */
function fakeMessages(
  content: unknown[],
  stopReason = "tool_use",
): AnthropicMessagesApi & {
  calls: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    async create(params) {
      calls.push(params);
      return {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: params.model,
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 1_000, output_tokens: 200 },
      } as unknown as Anthropic.Message;
    },
  };
}

const clickLogin = {
  type: "tool_use",
  id: "toolu_1",
  name: "click",
  input: {
    thought: "Credentials are filled in.",
    intent: "Click the Login button",
    target: { role: "button", name: "Login" },
  },
};

describe("AnthropicLlm", () => {
  it("sends one request with strict tools and auto tool choice", async () => {
    const messages = fakeMessages([clickLogin]);
    await new AnthropicLlm({ messages }).nextAction(request);

    expect(messages.calls).toHaveLength(1);
    const params = messages.calls[0];
    expect(params?.model).toBe("claude-sonnet-5-5");
    expect(params?.tool_choice).toEqual({
      type: "auto",
      disable_parallel_tool_use: true,
    });
    expect(params?.tools?.map((t) => (t as Anthropic.Tool).name)).toEqual([
      "navigate",
      "click",
      "type",
      "assert",
      "done",
    ]);
    for (const tool of params?.tools ?? []) {
      expect((tool as Anthropic.Tool).strict).toBe(true);
    }
    // Rejected by current models.
    expect(params).not.toHaveProperty("temperature");
    expect(params?.messages).toHaveLength(1);
    expect(JSON.stringify(params?.messages)).toContain(
      "Goal: Log in as standard_user",
    );
  });

  it("returns the decision, token usage and cost", async () => {
    const llm = new AnthropicLlm({ messages: fakeMessages([clickLogin]) });

    expect(await llm.nextAction(request)).toEqual({
      ok: true,
      usage: { inputTokens: 1_000, outputTokens: 200 },
      // 1,000 × $2/M + 200 × $10/M
      costUsd: 0.004,
      decision: {
        thought: "Credentials are filled in.",
        intent: "Click the Login button",
        action: { type: "click", target: { role: "button", name: "Login" } },
      },
    });
  });

  it("ignores text before the tool call", async () => {
    const llm = new AnthropicLlm({
      messages: fakeMessages([
        { type: "text", text: "I'll click Login." },
        clickLogin,
      ]),
    });
    expect((await llm.nextAction(request)).ok).toBe(true);
  });

  it("reports no_tool_call when the model only replies in text", async () => {
    const llm = new AnthropicLlm({
      messages: fakeMessages(
        [{ type: "text", text: "Which user should I log in as?" }],
        "end_turn",
      ),
    });

    const result = await llm.nextAction(request);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "no_tool_call" },
      usage: { inputTokens: 1_000, outputTokens: 200 },
    });
    if (!result.ok) {
      expect(result.error.message).toContain("end_turn");
      expect(result.error.message).toContain("Which user should I log in as?");
    }
  });

  it("reports invalid_tool_call when the input fails validation", async () => {
    const llm = new AnthropicLlm({
      messages: fakeMessages([
        {
          ...clickLogin,
          name: "assert",
          input: {
            thought: "Check the URL.",
            intent: "Check the URL",
            assertion: { kind: "urlMatches", pattern: "(" },
          },
        },
      ]),
    });

    expect(await llm.nextAction(request)).toMatchObject({
      ok: false,
      error: { code: "invalid_tool_call" },
    });
  });

  it("has no cost for a model without a known price", async () => {
    const llm = new AnthropicLlm({
      model: "claude-some-future-model",
      messages: fakeMessages([clickLogin]),
    });
    expect((await llm.nextAction(request)).costUsd).toBeUndefined();
  });
});
