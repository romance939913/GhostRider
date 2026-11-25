import type { TraceObservation } from "@ghostrider/shared";
import type { Page } from "playwright";
import { cleanSnapshotNames } from "./names.js";
import { compactSnapshot, DEFAULT_SNAPSHOT_BUDGET_CHARS } from "./snapshot.js";

const LOAD_TIMEOUT_MS = 10_000;
const NETWORK_IDLE_TIMEOUT_MS = 2_000;
/** How long to wait between snapshots when checking the page is stable. */
const STABLE_INTERVAL_MS = 200;
/** Give up waiting for stability after this (live feeds never stop changing). */
const STABLE_TIMEOUT_MS = 2_000;
const MASKED_PASSWORD = "••••••••";

export interface ObserveOptions {
  /** Max snapshot size sent to the model. Defaults to DEFAULT_SNAPSHOT_BUDGET_CHARS. */
  budgetChars?: number;
  /**
   * Secret values by name. Any occurrence in the snapshot is replaced with
   * `{{secrets.<name>}}`, so typed credentials never reach the model or the trace.
   */
  secrets?: Record<string, string>;
}

/**
 * Best-effort wait for the page to finish loading and go quiet.
 *
 * Neither wait is allowed to fail the observation: pages with long-polling or
 * analytics beacons never reach "networkidle", and a page that is slow to fire
 * "load" is still worth looking at.
 */
export async function waitForSettled(page: Page): Promise<void> {
  await page
    .waitForLoadState("load", { timeout: LOAD_TIMEOUT_MS })
    .catch(() => {});
  await page
    .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS })
    .catch(() => {});
}

/**
 * Takes snapshots until two in a row are identical (or a time limit).
 *
 * Load events don't cover single-page apps: after a client-side route change
 * the URL updates before the framework re-renders, and a single snapshot can
 * show the previous page. Waiting for the accessibility tree to stop
 * changing catches that, at the cost of ~200ms per step.
 */
export async function stableSnapshot(page: Page): Promise<string> {
  const body = page.locator("body");
  let previous = await body.ariaSnapshot();
  const deadline = Date.now() + STABLE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await page.waitForTimeout(STABLE_INTERVAL_MS);
    const current = await body.ariaSnapshot();
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

/** What the agent "sees" before choosing its next action. */
export async function observe(
  page: Page,
  options: ObserveOptions = {},
): Promise<TraceObservation> {
  await waitForSettled(page);
  const raw = await stableSnapshot(page);

  // Redact before compaction so a secret can't survive in a shortened line.
  // Playwright includes the value of every input, password fields included.
  const passwordValues = await page
    .locator('input[type="password"]')
    .evaluateAll((inputs) =>
      inputs.map((input) => (input as HTMLInputElement).value),
    );
  const redacted = redactValues(raw, [
    ...Object.entries(options.secrets ?? {}).map(([name, value]) => ({
      value,
      replacement: `{{secrets.${name}}}`,
    })),
    ...passwordValues.map((value) => ({ value, replacement: MASKED_PASSWORD })),
  ]);

  const { snapshot, truncated } = compactSnapshot(
    cleanSnapshotNames(redacted),
    {
      budgetChars: options.budgetChars ?? DEFAULT_SNAPSHOT_BUDGET_CHARS,
    },
  );

  return {
    url: page.url(),
    title: await page.title(),
    snapshot,
    snapshotChars: raw.length,
    truncated,
  };
}

export interface Redaction {
  value: string;
  replacement: string;
}

/**
 * Replaces every literal occurrence of each value. Longer values go first so
 * a secret that contains another secret is replaced whole. Also matches the
 * value as it appears inside a quoted YAML string (escaped quotes/backslashes).
 */
export function redactValues(text: string, redactions: Redaction[]): string {
  const sorted = redactions
    .filter((r) => r.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);

  let result = text;
  for (const { value, replacement } of sorted) {
    const escaped = JSON.stringify(value).slice(1, -1);
    result = result.split(value).join(replacement);
    if (escaped !== value) result = result.split(escaped).join(replacement);
  }
  return result;
}
