import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Action,
  ElementTarget,
  TRACE_FORMAT_VERSION,
  Trace,
  type TraceStep,
} from "./trace.js";

const fixtureJson: unknown = JSON.parse(
  readFileSync(
    new URL("./fixtures/saucedemo-login.trace.json", import.meta.url),
    "utf8",
  ),
);

/** Returns a deep copy of the (valid) fixture after applying `mutate`. */
function mutated(mutate: (trace: Trace) => void): unknown {
  const trace = structuredClone(Trace.parse(fixtureJson));
  mutate(trace);
  return trace;
}

function stepAt(trace: Trace, index: number): TraceStep {
  const step = trace.steps[index];
  if (!step) throw new Error(`fixture has no step ${index}`);
  return step;
}

/** Paths of all validation issues, e.g. ["steps.2.action.target"]. */
function issuePaths(input: unknown): string[] {
  const result = Trace.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join("."));
}

describe("Trace", () => {
  it("parses the saucedemo login fixture", () => {
    const result = Trace.safeParse(fixtureJson);
    expect(result.error?.issues).toBeUndefined();
    expect(result.data?.traceFormatVersion).toBe(TRACE_FORMAT_VERSION);
    expect(result.data?.steps.map((s) => s.action.type)).toEqual([
      "type",
      "type",
      "click",
      "assert",
      "done",
    ]);
  });

  it("keeps secrets as placeholders in the fixture", () => {
    const raw = JSON.stringify(fixtureJson);
    expect(raw).toContain("{{secrets.password}}");
    expect(raw).not.toContain('"text":"secret_sauce"');
  });

  it("rejects an unknown action type", () => {
    const input = mutated((t) => {
      (stepAt(t, 2) as { action: unknown }).action = {
        type: "hover",
        target: { role: "button", name: "Login" },
      };
    });
    expect(issuePaths(input)).toContain("steps.2.action.type");
  });

  it("rejects a click without a target", () => {
    const input = mutated((t) => {
      delete (stepAt(t, 2).action as { target?: unknown }).target;
    });
    expect(issuePaths(input)).toContain("steps.2.action.target");
  });

  it("rejects a failed result without an error", () => {
    const input = mutated((t) => {
      (stepAt(t, 2) as { result: unknown }).result = {
        ok: false,
        durationMs: 10,
      };
    });
    expect(issuePaths(input)).toContain("steps.2.result.error");
  });

  it("rejects a different trace format version", () => {
    const input = mutated((t) => {
      (t as { traceFormatVersion: number }).traceFormatVersion = 1;
    });
    expect(issuePaths(input)).toContain("traceFormatVersion");
  });

  it("rejects steps whose index doesn't match their position", () => {
    const input = mutated((t) => {
      stepAt(t, 3).index = 7;
    });
    expect(issuePaths(input)).toContain("steps.3.index");
  });

  it('rejects a "succeeded" trace that does not end with done(success: true)', () => {
    const input = mutated((t) => {
      t.steps.pop();
    });
    expect(issuePaths(input)).toContain("outcome.status");
  });

  it("accepts a failed trace that ends without done", () => {
    const input = mutated((t) => {
      t.steps.pop();
      t.outcome = { status: "step_limit", summary: "Ran out of steps" };
    });
    expect(issuePaths(input)).toEqual([]);
  });
});

describe("Action", () => {
  it("rejects a urlMatches assertion with an invalid regular expression", () => {
    const result = Action.safeParse({
      type: "assert",
      assertion: { kind: "urlMatches", pattern: "(" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a type action that submits with Enter", () => {
    const result = Action.safeParse({
      type: "type",
      target: { role: "searchbox", name: "Search Wikipedia" },
      text: "Playwright",
      submit: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("ElementTarget", () => {
  it("accepts nth for duplicate role + name", () => {
    expect(
      ElementTarget.safeParse({
        role: "textbox",
        name: "Enter your email",
        nth: 1,
      }).success,
    ).toBe(true);
  });

  it("rejects a negative nth", () => {
    expect(
      ElementTarget.safeParse({
        role: "textbox",
        name: "Enter your email",
        nth: -1,
      }).success,
    ).toBe(false);
  });
});
