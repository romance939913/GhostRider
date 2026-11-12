import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BrowserSession, launchBrowser } from "./browser.js";
import { type ObserveOptions, observe, redactValues } from "./observe.js";

// These tests drive a real (headless) Chromium. Locally: run
// `pnpm --filter @ghostrider/agent exec playwright install chromium` once.
let session: BrowserSession;

beforeAll(async () => {
  session = await launchBrowser();
}, 30_000);

afterAll(async () => {
  await session?.close();
});

async function observeHtml(html: string, options?: ObserveOptions) {
  await session.page.setContent(html);
  return observe(session.page, options);
}

describe("observe", () => {
  it("returns the title, URL and snapshot", async () => {
    const observation = await observeHtml("<title>Fixture page</title><h1>Hello</h1><button>Go</button>");

    expect(observation.title).toBe("Fixture page");
    expect(observation.url).toBe("about:blank");
    expect(observation.snapshot).toContain('- heading "Hello" [level=1]');
    expect(observation.snapshot).toContain('- button "Go"');
    expect(observation.truncated).toBe(false);
    expect(observation.snapshotChars).toBe(observation.snapshot.length);
  });

  it("shows the value typed into a text field", async () => {
    const observation = await observeHtml('<label>Username <input value="standard_user"></label>');

    expect(observation.snapshot).toContain('- textbox "Username": standard_user');
  });

  it("masks the value of password fields", async () => {
    const observation = await observeHtml(
      '<label>Password <input type="password" value="hunter2-do-not-leak"></label>',
    );

    expect(observation.snapshot).toContain('- textbox "Password"');
    expect(observation.snapshot).not.toContain("hunter2-do-not-leak");
  });

  it("replaces known secret values with their placeholders", async () => {
    const observation = await observeHtml('<label>API key <input value="sk-live-1234567890"></label>', {
      secrets: { apiKey: "sk-live-1234567890" },
    });

    expect(observation.snapshot).toContain('- textbox "API key": {{secrets.apiKey}}');
    expect(observation.snapshot).not.toContain("sk-live-1234567890");
  });

  it("includes an open dialog and its buttons (cookie banners, modals)", async () => {
    const observation = await observeHtml(
      "<main><h1>Shop</h1></main><dialog open><p>We use cookies.</p><button>Accept all</button></dialog>",
    );

    expect(observation.snapshot).toContain('- button "Accept all"');
  });

  it("leaves out hidden elements", async () => {
    const observation = await observeHtml(`
      <button style="display:none">Display none</button>
      <div aria-hidden="true"><button>Aria hidden</button></div>
      <button>Visible</button>
    `);

    expect(observation.snapshot).toContain('- button "Visible"');
    expect(observation.snapshot).not.toContain("Display none");
    expect(observation.snapshot).not.toContain("Aria hidden");
  });

  it("compacts large pages to the budget and keeps the actionable element", async () => {
    const paragraphs = Array.from(
      { length: 300 },
      (_, i) => `<p>Paragraph ${i}: some long marketing copy that the agent never needs to read.</p>`,
    ).join("");
    const observation = await observeHtml(`${paragraphs}<button>Buy now</button>`, { budgetChars: 2_000 });

    expect(observation.snapshotChars).toBeGreaterThan(2_000);
    expect(observation.snapshot.length).toBeLessThanOrEqual(2_000);
    expect(observation.truncated).toBe(true);
    expect(observation.snapshot).toContain('- button "Buy now"');
  });
});

describe("redactValues", () => {
  it("replaces every occurrence, longest value first", () => {
    const text = "token abc123456 and abc123 and abc123456";
    const result = redactValues(text, [
      { value: "abc123", replacement: "[short]" },
      { value: "abc123456", replacement: "[long]" },
    ]);

    expect(result).toBe("token [long] and [short] and [long]");
  });

  it("ignores empty values", () => {
    expect(redactValues("unchanged", [{ value: "", replacement: "x" }])).toBe("unchanged");
  });
});
