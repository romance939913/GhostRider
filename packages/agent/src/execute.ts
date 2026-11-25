import type {
  Action,
  Assertion,
  ElementTarget,
  StepErrorCode,
  StepResult,
} from "@ghostrider/shared";
import { errors, type Locator, type Page } from "playwright";
import { accessibleNameMatcher } from "./names.js";
import { ARIA_ROLES, type AriaRole } from "./roles.js";

const ACTION_TIMEOUT_MS = 5_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
/** Error messages go back to the model; keep them short and readable. */
const MAX_ERROR_MESSAGE_CHARS = 300;

export interface ExecuteOptions {
  /** Values for `{{secrets.<name>}}` placeholders in `type` actions. */
  secrets?: Record<string, string>;
  /** Timeout for finding, clicking, typing and asserting. */
  timeoutMs?: number;
  /** Timeout for `navigate`. */
  navigationTimeoutMs?: number;
}

function toAriaRole(role: string): AriaRole {
  if (!ARIA_ROLES.has(role)) {
    throw new StepError(
      "invalid_action",
      `"${role}" is not an ARIA role. Use a role exactly as shown in the snapshot.`,
    );
  }
  return role as AriaRole;
}

/** A failure we expect and report to the model, as opposed to a bug or crash. */
class StepError extends Error {
  constructor(
    readonly code: StepErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Performs one agent action in the browser and reports what happened.
 *
 * Expected failures (element missing, timeout, failed assertion, ...) come
 * back as `{ ok: false, error }` so the agent can see them and try something
 * else. Only a closed page (GhostRider's own problem) throws.
 *
 * The action is never modified: secret placeholders are resolved into a
 * local value, so the trace keeps `{{secrets.password}}`, not the password.
 */
export async function execute(
  page: Page,
  action: Action,
  options: ExecuteOptions = {},
): Promise<StepResult> {
  const startedAt = performance.now();
  const durationMs = () => Math.round(performance.now() - startedAt);

  try {
    await perform(page, action, options);
    return { ok: true, durationMs: durationMs(), urlAfter: page.url() };
  } catch (error) {
    if (page.isClosed()) throw error;
    return {
      ok: false,
      durationMs: durationMs(),
      error: toStepError(action, error),
    };
  }
}

async function perform(
  page: Page,
  action: Action,
  options: ExecuteOptions,
): Promise<void> {
  const timeout = options.timeoutMs ?? ACTION_TIMEOUT_MS;

  switch (action.type) {
    case "navigate":
      await page.goto(action.url, {
        waitUntil: "domcontentloaded",
        timeout: options.navigationTimeoutMs ?? NAVIGATION_TIMEOUT_MS,
      });
      return;

    case "click": {
      const element = await resolveTarget(page, action.target, timeout);
      await element.click({ timeout });
      return;
    }

    case "select": {
      const element = await resolveTarget(page, action.target, timeout);
      await selectOption(
        element,
        action.option,
        describeTarget(action.target),
        timeout,
      );
      return;
    }

    case "type": {
      // Resolve before touching the page so an unknown secret types nothing.
      const text = resolveSecrets(action.text, options.secrets ?? {});
      const element = await resolveTarget(page, action.target, timeout);
      await element.fill(text, { timeout });
      if (action.submit) await element.press("Enter", { timeout });
      return;
    }

    case "assert":
      await checkAssertion(page, action.assertion, timeout);
      return;

    case "done":
      // Nothing to do in the browser; the agent loop ends the recording.
      return;

    default: {
      // Compile error if a new action type is added without handling it here.
      const unhandled: never = action;
      throw new StepError(
        "invalid_action",
        `Unknown action ${JSON.stringify(unhandled)}`,
      );
    }
  }
}

/**
 * Finds exactly one visible element by role + accessible name (exact match).
 *
 * Several matches without `nth` is an error rather than a silent "pick the
 * first": the compiled script must target the same element on every run, so
 * the agent has to say which one it means.
 */
export async function resolveTarget(
  page: Page,
  target: ElementTarget,
  timeoutMs: number,
): Promise<Locator> {
  // Exact name, ignoring icon-font glyphs (see names.ts).
  const matches = page.getByRole(toAriaRole(target.role), {
    name: accessibleNameMatcher(target.name),
  });
  const label = describeTarget(target);

  try {
    // Wait for the first match so elements rendered a moment late are found.
    await matches.first().waitFor({ state: "attached", timeout: timeoutMs });
  } catch (error) {
    if (error instanceof errors.TimeoutError) {
      throw new StepError("element_not_found", `No element matches ${label}`);
    }
    throw error;
  }

  const count = await matches.count();
  if (target.nth === undefined) {
    if (count > 1) {
      throw new StepError(
        "ambiguous_target",
        `${count} elements match ${label}; set nth (0-${count - 1}) to pick one`,
      );
    }
    return matches.first();
  }
  if (target.nth >= count) {
    throw new StepError(
      "element_not_found",
      `${label} has ${count} match(es), so nth ${target.nth} doesn't exist`,
    );
  }
  return matches.nth(target.nth);
}

async function checkAssertion(
  page: Page,
  assertion: Assertion,
  timeout: number,
): Promise<void> {
  try {
    switch (assertion.kind) {
      case "textVisible":
        await page
          .getByText(assertion.text)
          .filter({ visible: true })
          .first()
          .waitFor({ state: "visible", timeout });
        return;

      case "elementVisible": {
        // For assertions, any visible match is fine: duplicates aren't ambiguous here.
        const matches = page.getByRole(toAriaRole(assertion.target.role), {
          name: accessibleNameMatcher(assertion.target.name),
        });
        const element =
          assertion.target.nth === undefined
            ? matches.filter({ visible: true }).first()
            : matches.nth(assertion.target.nth);
        await element.waitFor({ state: "visible", timeout });
        return;
      }

      case "fieldValue": {
        const element = await resolveTarget(page, assertion.target, timeout);
        await waitForFieldValue(element, assertion.value, timeout, () =>
          describeTarget(assertion.target),
        );
        return;
      }

      case "urlMatches":
        // Polls, so client-side (pushState) navigations are caught too.
        await page.waitForURL(new RegExp(assertion.pattern), {
          timeout,
          waitUntil: "commit",
        });
        return;
    }
  } catch (error) {
    if (error instanceof errors.TimeoutError) {
      throw new StepError(
        "assertion_failed",
        describeFailedAssertion(page, assertion),
      );
    }
    throw error;
  }
}

/**
 * Picks an option of a native <select> by its visible label. Clicking an
 * <option> doesn't work in a real browser, which is why this is its own
 * action. A missing label fails fast and lists the labels that do exist,
 * so the model can correct itself.
 */
async function selectOption(
  element: Locator,
  option: string,
  label: string,
  timeout: number,
): Promise<void> {
  const isSelect = await element.evaluate(
    (el) => el.tagName.toLowerCase() === "select",
  );
  if (!isSelect) {
    throw new StepError(
      "invalid_action",
      `${label} is not a native <select>. For a custom dropdown, click it open and then click the option.`,
    );
  }

  const labels = (await element.locator("option").allTextContents()).map(
    (text) => text.trim(),
  );
  if (!labels.includes(option)) {
    const shown = labels
      .slice(0, 20)
      .map((text) => JSON.stringify(text))
      .join(", ");
    throw new StepError(
      "element_not_found",
      `${label} has no option "${option}". Options: ${shown}`,
    );
  }

  await element.selectOption({ label: option }, { timeout });
}

const FIELD_VALUE_POLL_MS = 100;

/**
 * Waits until a field's value equals `expected`: an input's or textarea's
 * value, or the label of a native <select>'s selected option. Polls, like
 * the other assertions, so values set by scripts a moment later still pass.
 */
async function waitForFieldValue(
  element: Locator,
  expected: string,
  timeout: number,
  label: () => string,
): Promise<void> {
  const deadline = Date.now() + timeout;
  let actual = await readFieldValue(element);
  while (actual !== expected && Date.now() < deadline) {
    await element.page().waitForTimeout(FIELD_VALUE_POLL_MS);
    actual = await readFieldValue(element);
  }
  if (actual !== expected) {
    throw new StepError(
      "assertion_failed",
      `${label()} has value ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

function readFieldValue(element: Locator): Promise<string> {
  return element.evaluate((el) => {
    if (el instanceof HTMLSelectElement) {
      return el.selectedOptions[0]?.label.trim() ?? "";
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return el.value;
    }
    return el.textContent?.trim() ?? "";
  });
}

const SECRET_PLACEHOLDER = /\{\{secrets\.([A-Za-z0-9_]+)\}\}/g;

/** Replaces `{{secrets.<name>}}` placeholders. Unknown names are an error, never typed literally. */
export function resolveSecrets(
  text: string,
  secrets: Record<string, string>,
): string {
  return text.replace(SECRET_PLACEHOLDER, (_placeholder, name: string) => {
    const value = secrets[name];
    if (value === undefined) {
      throw new StepError(
        "invalid_action",
        `Unknown secret "${name}". Use only the secrets you were given.`,
      );
    }
    return value;
  });
}

function toStepError(
  action: Action,
  error: unknown,
): { code: StepErrorCode; message: string } {
  if (error instanceof StepError)
    return { code: error.code, message: error.message };

  const message = shorten(
    error instanceof Error ? error.message : String(error),
  );
  if (action.type === "navigate") return { code: "navigation_failed", message };
  if (error instanceof errors.TimeoutError) return { code: "timeout", message };
  // e.g. fill() on a button, an unknown role.
  return { code: "invalid_action", message };
}

function describeTarget(target: ElementTarget): string {
  const nth = target.nth === undefined ? "" : ` (nth ${target.nth})`;
  return `${target.role} "${target.name}"${nth}`;
}

function describeFailedAssertion(page: Page, assertion: Assertion): string {
  switch (assertion.kind) {
    case "textVisible":
      return `Text "${assertion.text}" is not visible`;
    case "elementVisible":
      return `${describeTarget(assertion.target)} is not visible`;
    case "fieldValue":
      return `${describeTarget(assertion.target)} does not have value ${JSON.stringify(assertion.value)}`;
    case "urlMatches":
      return `URL ${page.url()} does not match /${assertion.pattern}/`;
  }
}

/** First line of a Playwright error, without its call log, capped in length. */
function shorten(message: string): string {
  const firstLine = message.split("\n")[0] ?? message;
  return firstLine.length > MAX_ERROR_MESSAGE_CHARS
    ? `${firstLine.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : firstLine;
}
