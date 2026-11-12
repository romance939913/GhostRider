import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";

export interface LaunchOptions {
  /** Show the browser window. Defaults to headless. */
  headed?: boolean;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Closes the context and the browser. Safe to call more than once. */
  close: () => Promise<void>;
}

const VIEWPORT = { width: 1280, height: 800 };
const ACTION_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * Launches Chromium with a fresh, isolated browser context.
 *
 * Every recording (and later every run) gets its own context, so no cookies,
 * storage or logins leak between journeys.
 */
export async function launchBrowser(
  options: LaunchOptions = {},
): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: !options.headed });

  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);

    const page = await context.newPage();

    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await context.close();
      await browser.close();
    };

    return { browser, context, page, close };
  } catch (error) {
    // Don't leak a browser process if context setup fails.
    await browser.close();
    throw error;
  }
}
