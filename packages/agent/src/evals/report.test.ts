import { describe, expect, it } from "vitest";
import type { Trace, TraceStep } from "../trace.js";
import type { EvalJourney } from "./journeys.js";
import { EVAL_JOURNEYS } from "./journeys.js";
import { type EvalResult, finalUrl, grade, renderReport } from "./report.js";

const journey: EvalJourney = {
  id: "login",
  startUrl: "https://shop.test/",
  goal: "Log in",
  expect: { status: "succeeded", finalUrl: "/inventory\\.html$" },
  covers: "test",
};

function step(urlAfter: string | undefined): TraceStep {
  return {
    index: 0,
    observation: {
      url: "https://shop.test/before",
      title: "Shop",
      snapshot: "",
      snapshotChars: 0,
      truncated: false,
    },
    thought: "",
    intent: "Do it",
    action: { type: "done", success: true, summary: "Done" },
    result:
      urlAfter === undefined
        ? {
            ok: false,
            durationMs: 1,
            error: { code: "timeout", message: "slow" },
          }
        : { ok: true, durationMs: 1, urlAfter },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function trace(status: Trace["outcome"]["status"], steps: TraceStep[]): Trace {
  return {
    traceFormatVersion: 0,
    id: "3f1c2a9e-8b7d-4c6e-9a1f-2b3c4d5e6f70",
    goal: "Log in",
    startUrl: "https://shop.test/",
    model: { provider: "fake", name: "fake" },
    startedAt: "2026-11-23T10:00:00.000Z",
    finishedAt: "2026-11-23T10:00:30.000Z",
    outcome: { status, summary: `ended: ${status}` },
    steps,
    totals: { inputTokens: 1, outputTokens: 1 },
  };
}

describe("grade", () => {
  it("passes when the outcome and final URL match", () => {
    const result = grade(
      journey,
      trace("succeeded", [step("https://shop.test/inventory.html")]),
    );
    expect(result).toEqual({ passed: true, reason: "ended: succeeded" });
  });

  it("fails on a different outcome", () => {
    const result = grade(journey, trace("step_limit", []));
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("expected succeeded, got step_limit");
  });

  it("fails a success that ended on the wrong page", () => {
    const result = grade(
      journey,
      trace("succeeded", [step("https://shop.test/cart.html")]),
    );
    expect(result).toMatchObject({ passed: false });
    expect(result.reason).toContain("ended on https://shop.test/cart.html");
  });

  it("passes an expected failure", () => {
    const expectFailure = { ...journey, expect: { status: "failed" as const } };
    expect(grade(expectFailure, trace("failed", [])).passed).toBe(true);
  });
});

describe("grade: provenBy", () => {
  const dropdown: EvalJourney = {
    id: "dropdown",
    startUrl: "https://shop.test/",
    goal: "Select Option 2",
    expect: { status: "succeeded", provenBy: "Option 2" },
    covers: "test",
  };

  function assertStep(
    index: number,
    assertion: Extract<TraceStep["action"], { type: "assert" }>["assertion"],
    ok: boolean,
  ): TraceStep {
    return {
      ...step("https://shop.test/"),
      index,
      action: { type: "assert", assertion },
      result: ok
        ? { ok: true, durationMs: 1, urlAfter: "https://shop.test/" }
        : {
            ok: false,
            durationMs: 1,
            error: { code: "assertion_failed", message: "not visible" },
          },
    };
  }

  it("fails a success proven only by an unrelated assert", () => {
    // What actually happened in the first Step 8 eval run.
    const trace_ = trace("succeeded", [
      assertStep(0, { kind: "textVisible", text: "Option 2" }, false),
      assertStep(
        1,
        {
          kind: "elementVisible",
          target: { role: "heading", name: "Dropdown List" },
        },
        true,
      ),
    ]);

    const result = grade(dropdown, trace_);

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('no passing assert mentions "Option 2"');
  });

  it("passes when a passing assert proves the goal", () => {
    const trace_ = trace("succeeded", [
      assertStep(
        0,
        {
          kind: "fieldValue",
          target: { role: "combobox", name: "" },
          value: "Option 2",
        },
        true,
      ),
    ]);
    expect(grade(dropdown, trace_).passed).toBe(true);
  });
});

describe("finalUrl", () => {
  it("uses the last step's URL, or its observation if the step failed", () => {
    expect(finalUrl(trace("succeeded", [step("https://shop.test/a")]))).toBe(
      "https://shop.test/a",
    );
    expect(finalUrl(trace("error", [step(undefined)]))).toBe(
      "https://shop.test/before",
    );
    expect(finalUrl(trace("failed", []))).toBe("https://shop.test/");
  });
});

describe("renderReport", () => {
  const result: EvalResult = {
    journeyId: "login",
    run: 1,
    expected: "succeeded",
    outcome: "succeeded",
    passed: true,
    reason: "Logged in | ok",
    steps: 7,
    costUsd: 0.08,
    seconds: 37,
    traceFile: "/tmp/login.json",
  };

  it("summarizes pass rate and cost, one row per run", () => {
    const report = renderReport(
      [result, { ...result, run: 2, passed: false, costUsd: 0.12 }],
      {
        date: "2026-11-23 16:40",
        model: "claude-sonnet-5-5",
        commit: "abc1234",
      },
    );

    expect(report).toContain("**1/2 passed (50%)** · total $0.20");
    expect(report).toContain(
      "| login | ✅ | succeeded | succeeded | 7 | $0.080 | 37s | Logged in \\| ok |",
    );
    expect(report).toContain("| login #2 | ❌ |");
  });
});

describe("EVAL_JOURNEYS", () => {
  it("has unique ids and valid URL patterns", () => {
    const ids = EVAL_JOURNEYS.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const j of EVAL_JOURNEYS) {
      expect(() => new URL(j.startUrl)).not.toThrow();
      if (j.expect.finalUrl)
        expect(() => new RegExp(j.expect.finalUrl as string)).not.toThrow();
    }
  });

  it("includes at least one journey that must fail", () => {
    expect(EVAL_JOURNEYS.some((j) => j.expect.status === "failed")).toBe(true);
  });
});
