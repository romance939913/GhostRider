import type { Page } from "playwright";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { type RecordJourneyOptions, recordJourney } from "./agent.js";
import { type BrowserSession, launchBrowser } from "./browser.js";
import type {
  LlmClient,
  NextActionRequest,
  NextActionResult,
} from "./llm/types.js";
import { type Action, Trace } from "./trace.js";

// Drives a real headless Chromium with a scripted fake model: no network,
// no API key. Each test gets a fresh tab (see execute.test.ts for why).
let session: BrowserSession;
let page: Page;

beforeAll(async () => {
  session = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await session?.close();
});
beforeEach(async () => {
  page = await session.context.newPage();
});
afterEach(async () => {
  await page.close();
});

const SECRET = "hunter2-do-not-leak";

/** A login page: submitting the form replaces it with "Welcome". */
const LOGIN_URL = `data:text/html,${encodeURIComponent(`
  <title>Demo shop</title>
  <form id="login">
    <label>Username <input name="user"></label>
    <label>Password <input name="pass" type="password"></label>
    <button>Log in</button>
  </form>
  <script>
    document.getElementById("login").addEventListener("submit", (event) => {
      event.preventDefault();
      document.body.innerHTML = "<h1>Welcome</h1>";
    });
  </script>
`)}`;

const usage = { inputTokens: 100, outputTokens: 20 };

function decide(
  intent: string,
  action: Action,
  costUsd = 0.001,
): NextActionResult {
  return {
    ok: true,
    usage,
    costUsd,
    decision: { thought: `Thinking about: ${intent}`, intent, action },
  };
}

function unusable(message: string): NextActionResult {
  return {
    ok: false,
    usage,
    costUsd: 0.001,
    error: { code: "no_tool_call", message },
  };
}

/** A fake model that plays back `script` and records every request. */
function scriptedLlm(script: Array<NextActionResult | Error>) {
  const requests: NextActionRequest[] = [];
  const llm: LlmClient = {
    provider: "fake",
    model: "scripted",
    async nextAction(request) {
      requests.push(structuredClone(request));
      const next = script.shift();
      if (next === undefined) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { llm, requests };
}

const typeUserAction: Action = {
  type: "type",
  target: { role: "textbox", name: "Username" },
  text: "standard_user",
};
const typeUser = decide("Type the username", typeUserAction);
const typePassword = decide("Type the password", {
  type: "type",
  target: { role: "textbox", name: "Password" },
  text: "{{secrets.password}}",
});
const clickLogin = decide("Click Log in", {
  type: "click",
  target: { role: "button", name: "Log in" },
});
const assertWelcome = decide("Check the welcome message", {
  type: "assert",
  assertion: { kind: "textVisible", text: "Welcome" },
});
const doneOk = decide("Finish", {
  type: "done",
  success: true,
  summary: "Logged in.",
});

function record(llm: LlmClient, overrides: Partial<RecordJourneyOptions> = {}) {
  return recordJourney(page, {
    goal: "Log in",
    startUrl: LOGIN_URL,
    llm,
    secrets: { password: SECRET },
    ...overrides,
  });
}

describe("recordJourney", { timeout: 30_000 }, () => {
  it("records a successful journey as a valid trace", async () => {
    const { llm, requests } = scriptedLlm([
      typeUser,
      typePassword,
      clickLogin,
      assertWelcome,
      doneOk,
    ]);
    const seen: number[] = [];

    const trace = await record(llm, {
      onStep: (step) => seen.push(step.index),
    });

    expect(Trace.safeParse(trace).success).toBe(true);
    expect(trace.outcome).toEqual({
      status: "succeeded",
      summary: "Logged in.",
    });
    expect(trace.steps.map((s) => s.intent)).toEqual([
      "Type the username",
      "Type the password",
      "Click Log in",
      "Check the welcome message",
      "Finish",
    ]);
    expect(trace.steps.every((s) => s.result.ok)).toBe(true);
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(trace.model).toEqual({ provider: "fake", name: "scripted" });
    expect(trace.totals).toEqual({
      inputTokens: 500,
      outputTokens: 100,
      costUsd: 0.005,
    });
    // The model only ever learns the secret's name.
    expect(requests[0]?.secretNames).toEqual(["password"]);
  });

  it("never puts a secret value in the trace", async () => {
    const { llm, requests } = scriptedLlm([
      typeUser,
      typePassword,
      clickLogin,
      assertWelcome,
      doneOk,
    ]);

    const trace = await record(llm);

    expect(JSON.stringify(trace)).not.toContain(SECRET);
    expect(JSON.stringify(requests)).not.toContain(SECRET);
    expect(trace.steps[1]?.action).toMatchObject({
      text: "{{secrets.password}}",
    });
  });

  it("shows earlier steps and their results to the model", async () => {
    const wrongButton = decide("Click Sign in", {
      type: "click",
      target: { role: "button", name: "Sign in" },
    });
    const { llm, requests } = scriptedLlm([
      wrongButton,
      decide("Give up", {
        type: "done",
        success: false,
        summary: "No button.",
      }),
    ]);

    await record(llm);

    expect(requests[0]?.history).toEqual([]);
    expect(requests[1]?.history).toHaveLength(1);
    expect(requests[1]?.history[0]?.result).toMatchObject({
      ok: false,
      error: { code: "element_not_found" },
    });
  });

  it("rejects done(success: true) until an assert has passed", async () => {
    const { llm, requests } = scriptedLlm([
      typeUser,
      typePassword,
      clickLogin,
      doneOk, // too early: rejected, not executed
      assertWelcome,
      doneOk,
    ]);

    const trace = await record(llm);

    expect(trace.outcome.status).toBe("succeeded");
    expect(trace.steps.map((s) => s.action.type)).toEqual([
      "type",
      "type",
      "click",
      "assert",
      "done",
    ]);
    expect(requests[4]?.feedback).toContain("no assert has passed yet");
    // The rejected call's tokens are charged to the next real step.
    expect(trace.steps[3]?.usage).toEqual({
      inputTokens: 200,
      outputTokens: 40,
    });
    expect(trace.totals.inputTokens).toBe(600);
  });

  it("re-prompts with feedback after an unusable response", async () => {
    const { llm, requests } = scriptedLlm([
      unusable("Replied without calling a tool."),
      decide("Give up", { type: "done", success: false, summary: "Stop." }),
    ]);

    const trace = await record(llm);

    expect(requests[1]?.feedback).toBe("Replied without calling a tool.");
    expect(trace.steps).toHaveLength(1);
    expect(trace.outcome.status).toBe("failed");
  });

  it("gives up after too many unusable responses in a row", async () => {
    const { llm } = scriptedLlm([
      unusable("bad 1"),
      unusable("bad 2"),
      unusable("bad 3"),
    ]);

    const trace = await record(llm);

    expect(trace.outcome.status).toBe("error");
    expect(trace.outcome.summary).toContain("bad 3");
    expect(trace.steps).toEqual([]);
  });

  it("stops at the step limit", async () => {
    const { llm } = scriptedLlm([typeUser, typeUser, typeUser]);

    const trace = await record(llm, { maxSteps: 2 });

    expect(trace.outcome.status).toBe("step_limit");
    expect(trace.steps).toHaveLength(2);
  });

  it("stops when the cost budget is used up", async () => {
    const pricey = decide("Type the username", typeUserAction, 0.3);
    const { llm } = scriptedLlm([pricey, pricey, pricey]);

    const trace = await record(llm, { maxCostUsd: 0.5 });

    expect(trace.outcome.status).toBe("budget_exceeded");
    expect(trace.steps).toHaveLength(2);
    expect(trace.totals.costUsd).toBe(0.6);
  });

  it("returns a partial trace with outcome error when the model API fails", async () => {
    const { llm } = scriptedLlm([typeUser, new Error("529 overloaded")]);

    const trace = await record(llm);

    expect(trace.outcome).toEqual({
      status: "error",
      summary: "Recording stopped by an error: 529 overloaded",
    });
    expect(trace.steps).toHaveLength(1);
  });

  it("fails without asking the model when the start URL can't load", async () => {
    const { llm, requests } = scriptedLlm([]);

    const trace = await record(llm, { startUrl: "http://127.0.0.1:1/" });

    expect(trace.outcome.status).toBe("failed");
    expect(trace.outcome.summary).toContain("Could not load the start URL");
    expect(requests).toEqual([]);
  });
});
