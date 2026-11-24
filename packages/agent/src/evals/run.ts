import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { DEFAULT_MAX_COST_USD, recordJourney } from "../agent.js";
import { launchBrowser } from "../browser.js";
import { AnthropicLlm, DEFAULT_ANTHROPIC_MODEL } from "../llm/anthropic.js";
import { EVAL_JOURNEYS } from "./journeys.js";
import { type EvalResult, grade, renderReport } from "./report.js";

/** The spec's bar for M1 (v1-product-spec.md, section 9). */
const PASS_RATE_TARGET = 0.8;

/** Reports are committed; traces are git-ignored. */
const RESULTS_DIR = new URL("../../eval-results/", import.meta.url);
const TRACES_DIR = new URL("../../../../traces/evals/", import.meta.url);

const USAGE = `Usage: pnpm --filter @ghostrider/agent eval [options]

Records every journey in the eval set with the real model, grades each one,
and writes a Markdown report to packages/agent/eval-results/.

Options:
  --only      Comma-separated journey ids to run (default: all).
  --repeat    Run each journey N times, to measure flakiness (default 1).
  --model     Anthropic model (default ${DEFAULT_ANTHROPIC_MODEL}).
  --max-cost  Per-journey spend limit in USD (default ${DEFAULT_MAX_COST_USD}).
  --headed    Show the browser window.
  -h, --help  Show this message.

Journeys: ${EVAL_JOURNEYS.map((j) => j.id).join(", ")}`;

function gitCommit(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
        .length > 0;
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      repeat: { type: "string", default: "1" },
      model: { type: "string", default: DEFAULT_ANTHROPIC_MODEL },
      "max-cost": { type: "string", default: String(DEFAULT_MAX_COST_USD) },
      headed: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY is not set (put it in .env).");
    return 1;
  }

  const repeat = Number(values.repeat);
  const maxCostUsd = Number(values["max-cost"]);
  if (!Number.isInteger(repeat) || repeat < 1) {
    console.error("Error: --repeat must be a positive integer");
    return 1;
  }
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    console.error("Error: --max-cost must be a positive number");
    return 1;
  }

  const only = values.only?.split(",").map((id) => id.trim());
  const unknown = only?.filter((id) => !EVAL_JOURNEYS.some((j) => j.id === id));
  if (unknown && unknown.length > 0) {
    console.error(
      `Error: unknown journey(s): ${unknown.join(", ")}\n\n${USAGE}`,
    );
    return 1;
  }
  const journeys = EVAL_JOURNEYS.filter((j) => !only || only.includes(j.id));

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tracesDir = new URL(`${stamp}/`, TRACES_DIR);
  await mkdir(tracesDir, { recursive: true });
  await mkdir(RESULTS_DIR, { recursive: true });

  const llm = new AnthropicLlm({ model: values.model });
  const results: EvalResult[] = [];
  console.log(
    `Running ${journeys.length} journeys × ${repeat} with ${llm.model}\n`,
  );

  for (const journey of journeys) {
    for (let run = 1; run <= repeat; run++) {
      const label = journey.id + (repeat > 1 ? ` #${run}` : "");
      const session = await launchBrowser({ headed: values.headed });
      try {
        const trace = await recordJourney(session.page, {
          goal: journey.goal,
          startUrl: journey.startUrl,
          llm,
          secrets: journey.secrets,
          maxCostUsd,
        });
        const file = new URL(
          `${journey.id}${repeat > 1 ? `-${run}` : ""}.json`,
          tracesDir,
        );
        await writeFile(file, `${JSON.stringify(trace, null, 2)}\n`);

        const { passed, reason } = grade(journey, trace);
        const seconds =
          (Date.parse(trace.finishedAt) - Date.parse(trace.startedAt)) / 1000;
        results.push({
          journeyId: journey.id,
          run,
          expected: journey.expect.status,
          outcome: trace.outcome.status,
          passed,
          reason,
          steps: trace.steps.length,
          costUsd: trace.totals.costUsd,
          seconds,
          traceFile: file.pathname,
        });

        const cost =
          trace.totals.costUsd === undefined
            ? "?"
            : `$${trace.totals.costUsd.toFixed(3)}`;
        console.log(
          `${passed ? "✅" : "❌"} ${label.padEnd(32)} ${trace.outcome.status.padEnd(16)} ${String(trace.steps.length).padStart(2)} steps  ${cost.padStart(7)}  ${seconds.toFixed(0).padStart(3)}s`,
        );
        if (!passed) console.log(`   ${reason}`);
      } finally {
        await session.close();
      }
    }
  }

  const report = renderReport(results, {
    date: new Date().toISOString().slice(0, 16).replace("T", " "),
    model: llm.model,
    commit: gitCommit(),
  });
  const reportFile = new URL(`${stamp}.md`, RESULTS_DIR);
  await writeFile(reportFile, report);

  const passed = results.filter((r) => r.passed).length;
  console.log(
    `\n${passed}/${results.length} passed · report: ${reportFile.pathname}`,
  );
  console.log(`Traces: ${tracesDir.pathname}`);
  return passed / results.length >= PASS_RATE_TARGET ? 0 : 1;
}

process.exitCode = await main();
