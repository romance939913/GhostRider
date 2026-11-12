import type { Page } from "playwright";

/** What the agent "sees" before choosing its next action. */
export interface Observation {
  url: string;
  title: string;
  /** Playwright ARIA snapshot (YAML-like tree of roles and accessible names). */
  snapshot: string;
  /** Snapshot length in characters, a rough proxy for prompt size. */
  snapshotChars: number;
}

export async function observe(page: Page): Promise<Observation> {
  const snapshot = await page.locator("body").ariaSnapshot();

  return {
    url: page.url(),
    title: await page.title(),
    snapshot,
    snapshotChars: snapshot.length,
  };
}
