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
import { type BrowserSession, launchBrowser } from "./browser.js";
import { type ExecuteOptions, execute, resolveSecrets } from "./execute.js";
import { type Action, StepResult } from "./trace.js";

// Drives a real headless Chromium (see observe.test.ts).
let session: BrowserSession;

beforeAll(async () => {
  session = await launchBrowser();
}, 30_000);

afterAll(async () => {
  await session?.close();
});

// Short timeouts keep the "this should fail" tests fast.
const FAST: ExecuteOptions = { timeoutMs: 500, navigationTimeoutMs: 2_000 };

/** Fixture page. Buttons record clicks in window.clicked, the form records submits. */
const PAGE = `
  <h1>Shop</h1>
  <button onclick="window.clicked.push('buy')">Buy now</button>
  <button onclick="window.clicked.push('cart-0')">Add to cart</button>
  <button onclick="window.clicked.push('cart-1')">Add to cart</button>
  <button disabled>Sold out</button>
  <form onsubmit="event.preventDefault(); window.submitted = document.querySelector('#q').value">
    <label>Search <input id="q"></label>
  </form>
  <label>Password <input id="pw" type="password"></label>
  <p id="late"></p>
  <script>
    window.clicked = [];
    window.submitted = null;
    setTimeout(() => { document.querySelector('#late').textContent = 'Order confirmed'; }, 200);
  </script>
`;

// A fresh tab per test. Reusing one tab leaks state between tests: after a
// failed navigation, Chromium loads its error page asynchronously, after
// goto() has already rejected, and that navigation lands in the next test.
let page: Page;

beforeEach(async () => {
  page = await session.context.newPage();
  await page.setContent(PAGE);
});

afterEach(async () => {
  await page.close();
});

async function run(
  action: Action,
  options: ExecuteOptions = FAST,
): Promise<StepResult> {
  const result = await execute(page, action, options);
  // Every result must be a valid trace StepResult.
  expect(StepResult.safeParse(result).success).toBe(true);
  return result;
}

const evaluate = <T>(expression: string) =>
  page.evaluate(expression) as Promise<T>;

describe("click", () => {
  it("clicks the element with the exact role and name", async () => {
    const result = await run({
      type: "click",
      target: { role: "button", name: "Buy now" },
    });

    expect(result).toMatchObject({ ok: true, urlAfter: "about:blank" });
    expect(await evaluate("window.clicked")).toEqual(["buy"]);
  });

  it("reports element_not_found when nothing matches", async () => {
    const result = await run({
      type: "click",
      target: { role: "button", name: "Checkout" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "element_not_found",
        message: 'No element matches button "Checkout"',
      },
    });
  });

  it("matches names exactly, not by substring", async () => {
    const result = await run({
      type: "click",
      target: { role: "button", name: "Buy" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "element_not_found" },
    });
  });

  it("refuses to guess between duplicates", async () => {
    const result = await run({
      type: "click",
      target: { role: "button", name: "Add to cart" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "ambiguous_target" },
    });
    if (!result.ok) expect(result.error.message).toContain("2 elements match");
    expect(await evaluate("window.clicked")).toEqual([]);
  });

  it("clicks the nth duplicate", async () => {
    const result = await run({
      type: "click",
      target: { role: "button", name: "Add to cart", nth: 1 },
    });

    expect(result.ok).toBe(true);
    expect(await evaluate("window.clicked")).toEqual(["cart-1"]);
  });

  it("reports element_not_found for an nth that doesn't exist", async () => {
    const result = await run({
      type: "click",
      target: { role: "button", name: "Add to cart", nth: 5 },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "element_not_found" },
    });
  });

  it("times out on a disabled button", async () => {
    const result = await run({
      type: "click",
      target: { role: "button", name: "Sold out" },
    });

    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    if (!result.ok) expect(result.error.message).not.toContain("\n");
  });

  it("reports invalid_action for an unknown role", async () => {
    const result = await run({
      type: "click",
      target: { role: "not-a-role", name: "Buy now" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_action" },
    });
  });
});

describe("type", () => {
  it("fills a text field and presses Enter when submit is set", async () => {
    const result = await run({
      type: "type",
      target: { role: "textbox", name: "Search" },
      text: "running shoes",
      submit: true,
    });

    expect(result.ok).toBe(true);
    expect(await evaluate("window.submitted")).toBe("running shoes");
  });

  it("types the secret value, not the placeholder", async () => {
    const action: Action = {
      type: "type",
      target: { role: "textbox", name: "Password" },
      text: "{{secrets.password}}",
    };

    const result = await run(action, {
      ...FAST,
      secrets: { password: "secret_sauce" },
    });

    expect(result.ok).toBe(true);
    expect(await evaluate("document.querySelector('#pw').value")).toBe(
      "secret_sauce",
    );
    // The action (which goes into the trace) still holds the placeholder.
    expect(action.text).toBe("{{secrets.password}}");
  });

  it("types nothing when a secret is unknown", async () => {
    const result = await run({
      type: "type",
      target: { role: "textbox", name: "Password" },
      text: "{{secrets.adminPassword}}",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_action" },
    });
    expect(await evaluate("document.querySelector('#pw').value")).toBe("");
  });

  it("reports invalid_action when typing into a button", async () => {
    const result = await run({
      type: "type",
      target: { role: "button", name: "Buy now" },
      text: "hi",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_action" },
    });
  });
});

describe("assert", () => {
  it("passes when the text is visible", async () => {
    expect(
      (
        await run({
          type: "assert",
          assertion: { kind: "textVisible", text: "Shop" },
        })
      ).ok,
    ).toBe(true);
  });

  it("waits for text that appears shortly after", async () => {
    const result = await run({
      type: "assert",
      assertion: { kind: "textVisible", text: "Order confirmed" },
    });

    expect(result.ok).toBe(true);
  });

  it("fails with assertion_failed when the text never appears", async () => {
    const result = await run({
      type: "assert",
      assertion: { kind: "textVisible", text: "Payment declined" },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "assertion_failed",
        message: 'Text "Payment declined" is not visible',
      },
    });
  });

  it("treats duplicates as fine for elementVisible", async () => {
    const result = await run({
      type: "assert",
      assertion: {
        kind: "elementVisible",
        target: { role: "button", name: "Add to cart" },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("checks the URL against a regular expression", async () => {
    const pass = await run({
      type: "assert",
      assertion: { kind: "urlMatches", pattern: "^about:blank$" },
    });
    const fail = await run({
      type: "assert",
      assertion: { kind: "urlMatches", pattern: "/inventory\\.html$" },
    });

    expect(pass.ok).toBe(true);
    expect(fail).toMatchObject({
      ok: false,
      error: { code: "assertion_failed" },
    });
  });
});

describe("navigate", () => {
  it("loads the URL and reports where it ended up", async () => {
    const url = "data:text/html,<h1>Second page</h1>";
    const result = await run({ type: "navigate", url });

    expect(result).toMatchObject({ ok: true, urlAfter: url });
  });

  it("reports navigation_failed when the site is unreachable", async () => {
    // Port 1 on localhost refuses connections immediately; no network needed.
    const result = await run({ type: "navigate", url: "http://127.0.0.1:1/" });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "navigation_failed" },
    });
  });
});

describe("done", () => {
  it("succeeds without touching the page", async () => {
    const result = await run({
      type: "done",
      success: true,
      summary: "All good",
    });

    expect(result).toMatchObject({ ok: true, urlAfter: "about:blank" });
  });
});

describe("resolveSecrets", () => {
  it("replaces every placeholder and leaves other text alone", () => {
    expect(
      resolveSecrets("{{secrets.user}}:{{secrets.pass}} at {{host}}", {
        user: "u",
        pass: "p",
      }),
    ).toBe("u:p at {{host}}");
  });

  it("throws on an unknown secret", () => {
    expect(() => resolveSecrets("{{secrets.nope}}", {})).toThrow(
      'Unknown secret "nope"',
    );
  });
});
