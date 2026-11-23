import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_STEPS,
  recordJourney,
} from "./agent.js";
import { launchBrowser } from "./browser.js";
import { AnthropicLlm, DEFAULT_ANTHROPIC_MODEL } from "./llm/anthropic.js";
import { describeAction } from "./llm/prompt.js";
import { observe } from "./observe.js";
import { DEFAULT_SNAPSHOT_BUDGET_CHARS } from "./snapshot.js";
import type { Trace, TraceStep } from "./trace.js";

/** Repo-root traces/ (git-ignored). */
const TRACES_DIR = new URL("../../../traces/", import.meta.url);

const USAGE = `Usage: pnpm --filter @ghostrider/agent record --url <url> [options]

Without --goal, prints the page's (compacted) accessibility snapshot.
With --goal, records the journey: the agent works through the site step by
step, and the trace is saved to traces/<id>.json.

Options:
  --url        Page to start on (http or https). Required.
  --goal       The journey in plain English.
  --secret     name=value, repeatable. The model only sees {{secrets.name}}.
  --model      Anthropic model (default ${DEFAULT_ANTHROPIC_MODEL}).
  --max-steps  Stop after this many steps (default ${DEFAULT_MAX_STEPS}).
  --max-cost   Stop after spending this many USD (default ${DEFAULT_MAX_COST_USD}).
  --budget     Max snapshot size in characters (default ${DEFAULT_SNAPSHOT_BUDGET_CHARS}).
  --headed     Show the browser window.
  -h, --help   Show this message.`;

interface CliArgs {
  url: string;
  goal: string | undefined;
  secrets: Record<string, string>;
  model: string;
  maxSteps: number;
  maxCostUsd: number;
  budgetChars: number;
  headed: boolean;
}

function parseCliArgs(argv: string[]): CliArgs | { error: string } | "help" {
  let values: {
    url?: string;
    goal?: string;
    secret?: string[];
    model?: string;
    "max-steps"?: string;
    "max-cost"?: string;
    budget?: string;
    headed?: boolean;
    help?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        goal: { type: "string" },
        secret: { type: "string", multiple: true },
        model: { type: "string" },
        "max-steps": { type: "string" },
        "max-cost": { type: "string" },
        budget: { type: "string" },
        headed: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      // pnpm can forward a bare "--"; ignore positionals instead of failing.
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    return { error: (error as Error).message };
  }

  if (values.help) return "help";
  if (!values.url) return { error: "--url is required" };

  let parsed: URL;
  try {
    parsed = new URL(values.url);
  } catch {
    return { error: `Not a valid URL: ${values.url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `URL must be http or https, got ${parsed.protocol}` };
  }

  const budgetChars = positiveNumber(
    values.budget,
    DEFAULT_SNAPSHOT_BUDGET_CHARS,
  );
  const maxSteps = positiveNumber(values["max-steps"], DEFAULT_MAX_STEPS);
  const maxCostUsd = positiveNumber(values["max-cost"], DEFAULT_MAX_COST_USD);
  if (!Number.isInteger(budgetChars)) {
    return { error: "--budget must be a positive integer" };
  }
  if (!Number.isInteger(maxSteps)) {
    return { error: "--max-steps must be a positive integer" };
  }
  if (Number.isNaN(maxCostUsd)) {
    return { error: "--max-cost must be a positive number" };
  }

  const secrets: Record<string, string> = {};
  for (const pair of values.secret ?? []) {
    const match = /^([A-Za-z0-9_]+)=(.*)$/s.exec(pair);
    if (!match?.[1] || match[2] === undefined) {
      return {
        error: "--secret must look like name=value (name: A-Z, 0-9, _)",
      };
    }
    secrets[match[1]] = match[2];
  }

  return {
    url: parsed.href,
    goal: values.goal,
    secrets,
    model: values.model ?? DEFAULT_ANTHROPIC_MODEL,
    maxSteps,
    maxCostUsd,
    budgetChars,
    headed: values.headed ?? false,
  };
}

/** Parses a positive number; NaN when invalid, `fallback` when absent. */
function positiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Number.NaN;
}

function printStep(step: TraceStep): void {
  const status = step.result.ok
    ? "✓"
    : `✗ ${step.result.error.code}: ${step.result.error.message}`;
  console.log(`${String(step.index + 1).padStart(2)}. ${step.intent}`);
  console.log(`    ${describeAction(step.action)}  ${status}`);
}

function printSummary(trace: Trace, path: string): void {
  const seconds =
    (Date.parse(trace.finishedAt) - Date.parse(trace.startedAt)) / 1000;
  const cost =
    trace.totals.costUsd === undefined
      ? "cost unknown"
      : `$${trace.totals.costUsd.toFixed(4)}`;
  console.log(`\nOutcome: ${trace.outcome.status}: ${trace.outcome.summary}`);
  console.log(
    `${trace.steps.length} steps · ${trace.totals.inputTokens} in / ${trace.totals.outputTokens} out · ${cost} · ${seconds.toFixed(1)}s`,
  );
  console.log(`Trace:   ${path}`);
}

async function main(): Promise<number> {
  const args = parseCliArgs(process.argv.slice(2));

  if (args === "help") {
    console.log(USAGE);
    return 0;
  }
  if ("error" in args) {
    console.error(`Error: ${args.error}\n\n${USAGE}`);
    return 1;
  }
  if (args.goal && !process.env.ANTHROPIC_API_KEY) {
    console.error("Error: --goal needs ANTHROPIC_API_KEY (set it in .env).");
    return 1;
  }

  const session = await launchBrowser({ headed: args.headed });
  try {
    if (!args.goal) {
      await session.page.goto(args.url, { waitUntil: "domcontentloaded" });
      const observation = await observe(session.page, {
        budgetChars: args.budgetChars,
        secrets: args.secrets,
      });
      const compacted = observation.truncated
        ? ` → ${observation.snapshot.length} chars (compacted)`
        : "";
      console.log(`URL:      ${observation.url}`);
      console.log(`Title:    ${observation.title}`);
      console.log(`Snapshot: ${observation.snapshotChars} chars${compacted}\n`);
      console.log(observation.snapshot);
      return 0;
    }

    const llm = new AnthropicLlm({ model: args.model });
    console.log(`Goal:  ${args.goal}`);
    console.log(`Start: ${args.url}`);
    console.log(`Model: ${llm.model}\n`);

    const trace = await recordJourney(session.page, {
      goal: args.goal,
      startUrl: args.url,
      llm,
      secrets: args.secrets,
      maxSteps: args.maxSteps,
      maxCostUsd: args.maxCostUsd,
      budgetChars: args.budgetChars,
      onStep: printStep,
    });

    await mkdir(TRACES_DIR, { recursive: true });
    const file = new URL(`${trace.id}.json`, TRACES_DIR);
    await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`);
    printSummary(trace, file.pathname);
    return trace.outcome.status === "succeeded" ? 0 : 1;
  } catch (error) {
    console.error(`Failed on ${args.url}:`, error);
    return 1;
  } finally {
    await session.close();
  }
}

process.exitCode = await main();
