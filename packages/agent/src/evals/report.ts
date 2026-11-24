import type { Trace } from "../trace.js";
import type { EvalJourney } from "./journeys.js";

export interface EvalResult {
  journeyId: string;
  /** 1-based, when a journey is repeated with --repeat. */
  run: number;
  expected: string;
  outcome: Trace["outcome"]["status"];
  passed: boolean;
  /** Why it failed, or the outcome summary when it passed. */
  reason: string;
  steps: number;
  costUsd: number | undefined;
  seconds: number;
  traceFile: string;
}

/** Final page URL: where the last step ended, else the last observed URL. */
export function finalUrl(trace: Trace): string {
  const last = trace.steps.at(-1);
  if (!last) return trace.startUrl;
  return last.result.ok ? last.result.urlAfter : last.observation.url;
}

/** Did the recording end the way the journey expects? */
export function grade(
  journey: EvalJourney,
  trace: Trace,
): { passed: boolean; reason: string } {
  const { status, finalUrl: urlPattern } = journey.expect;

  if (trace.outcome.status !== status) {
    return {
      passed: false,
      reason: `expected ${status}, got ${trace.outcome.status}: ${trace.outcome.summary}`,
    };
  }
  if (urlPattern !== undefined) {
    const url = finalUrl(trace);
    if (!new RegExp(urlPattern).test(url)) {
      return {
        passed: false,
        reason: `ended on ${url}, expected a URL matching /${urlPattern}/`,
      };
    }
  }
  const { provenBy } = journey.expect;
  if (provenBy !== undefined && !passingAssertMentions(trace, provenBy)) {
    return {
      passed: false,
      reason: `no passing assert mentions ${JSON.stringify(provenBy)}, so the success isn't proven`,
    };
  }
  return { passed: true, reason: trace.outcome.summary };
}

function passingAssertMentions(trace: Trace, text: string): boolean {
  return trace.steps.some(
    (step) =>
      step.action.type === "assert" &&
      step.result.ok &&
      JSON.stringify(step.action.assertion).includes(text),
  );
}

export interface ReportMeta {
  date: string;
  model: string;
  commit: string;
}

/** Results as a Markdown report: summary, then one row per run. */
export function renderReport(results: EvalResult[], meta: ReportMeta): string {
  const passed = results.filter((r) => r.passed).length;
  const rate = results.length === 0 ? 0 : (passed / results.length) * 100;
  const costs = results.map((r) => r.costUsd);
  const totalCost = costs.every((c) => c !== undefined)
    ? `$${costs.reduce((sum, c) => sum + c, 0).toFixed(2)}`
    : "unknown";
  const average = (values: number[]) =>
    values.length === 0
      ? 0
      : values.reduce((sum, v) => sum + v, 0) / values.length;

  const rows = results.map((r) =>
    [
      r.journeyId + (r.run > 1 ? ` #${r.run}` : ""),
      r.passed ? "✅" : "❌",
      r.expected,
      r.outcome,
      String(r.steps),
      r.costUsd === undefined ? "?" : `$${r.costUsd.toFixed(3)}`,
      `${r.seconds.toFixed(0)}s`,
      escapeCell(r.reason),
    ].join(" | "),
  );

  return [
    `# Agent eval: ${meta.date}`,
    "",
    `Model \`${meta.model}\` · commit \`${meta.commit}\``,
    "",
    `**${passed}/${results.length} passed (${rate.toFixed(0)}%)** · total ${totalCost} · avg ${average(results.map((r) => r.steps)).toFixed(1)} steps · avg ${average(results.map((r) => r.seconds)).toFixed(0)}s`,
    "",
    "| Journey | Pass | Expected | Outcome | Steps | Cost | Time | Notes |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row} |`),
    "",
  ].join("\n");
}

function escapeCell(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").replace(/\|/g, "\\|");
  return oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine;
}
