import { errors, type Locator, type Page } from "playwright";
import type {
  Action,
  Assertion,
  ElementTarget,
  StepErrorCode,
  StepResult,
} from "./trace.js";

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

type AriaRole = Parameters<Page["getByRole"]>[0];

/**
 * Every role Playwright's getByRole accepts. Playwright doesn't reject an
 * unknown role, it just matches nothing, which would send the agent looking
 * for an element that can't exist. `satisfies` keeps this list in sync with
 * Playwright's own type: a typo here is a compile error.
 */
const ARIA_ROLES: ReadonlySet<string> = new Set([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "meter",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
] as const satisfies readonly AriaRole[]);

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
  const matches = page.getByRole(toAriaRole(target.role), {
    name: target.name,
    exact: true,
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
          name: assertion.target.name,
          exact: true,
        });
        const element =
          assertion.target.nth === undefined
            ? matches.filter({ visible: true }).first()
            : matches.nth(assertion.target.nth);
        await element.waitFor({ state: "visible", timeout });
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
