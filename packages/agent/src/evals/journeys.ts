import type { TraceOutcomeStatus } from "../trace.js";

/**
 * The M1 eval set: real journeys on sites built for test automation.
 *
 * It deliberately includes journeys the agent should fail (to prove it
 * doesn't fake success) and journeys that need features it doesn't have
 * yet (to show what to build next). The spec's bar for M1 is 80% passing.
 *
 * Credentials here are the sites' published demo credentials.
 */
export interface EvalJourney {
  /** Stable id, used for --only and in result tables. */
  id: string;
  startUrl: string;
  goal: string;
  secrets?: Record<string, string>;
  expect: {
    status: TraceOutcomeStatus;
    /** For successful journeys: regex the final URL must match. */
    finalUrl?: string;
  };
  /** What this journey exercises, for reading the results. */
  covers: string;
}

const SAUCEDEMO = "https://www.saucedemo.com/";
const THE_INTERNET = "https://the-internet.herokuapp.com";

export const EVAL_JOURNEYS: readonly EvalJourney[] = [
  {
    id: "saucedemo-login",
    startUrl: SAUCEDEMO,
    goal: "Log in as standard_user and confirm the Products page loads.",
    secrets: { password: "secret_sauce" },
    expect: { status: "succeeded", finalUrl: "/inventory\\.html$" },
    covers: "Basic form login with a secret",
  },
  {
    id: "saucedemo-locked-out",
    startUrl: SAUCEDEMO,
    goal: "Log in as locked_out_user and confirm the Products page loads.",
    secrets: { password: "secret_sauce" },
    expect: { status: "failed" },
    covers:
      "Must report failure instead of faking success (user is locked out)",
  },
  {
    id: "saucedemo-checkout",
    startUrl: SAUCEDEMO,
    goal: "Log in as standard_user, add the Sauce Labs Backpack to the cart, check out as Test User with postal code 10001, finish the order and confirm it was placed.",
    secrets: { password: "secret_sauce" },
    expect: { status: "succeeded", finalUrl: "/checkout-complete\\.html$" },
    covers: "Long multi-page flow (about 12 steps)",
  },
  {
    id: "the-internet-login",
    startUrl: `${THE_INTERNET}/login`,
    goal: "Log in with username tomsmith and confirm you reach the secure area.",
    secrets: { password: "SuperSecretPassword!" },
    expect: { status: "succeeded", finalUrl: "/secure$" },
    covers: "Login with a flash message; secret with special characters",
  },
  {
    id: "the-internet-dynamic-loading",
    startUrl: `${THE_INTERNET}/dynamic_loading/2`,
    goal: "Start the loading and confirm the text that appears when it finishes.",
    expect: { status: "succeeded" },
    covers: "Content that appears seconds after an action",
  },
  {
    id: "the-internet-dropdown",
    startUrl: `${THE_INTERNET}/dropdown`,
    goal: 'Select "Option 2" in the dropdown and confirm it is selected.',
    expect: { status: "succeeded" },
    covers: "Native <select>: needs a select action (spec 5.1), not built yet",
  },
  {
    id: "todomvc",
    startUrl: "https://demo.playwright.dev/todomvc/",
    goal: 'Add the todos "Buy milk" and "Walk the dog", mark "Buy milk" as completed, and confirm that 1 item is left.',
    expect: { status: "succeeded" },
    covers: "Single-page app: typing with Enter, checkboxes, live counters",
  },
  {
    id: "wikipedia-search",
    startUrl: "https://en.wikipedia.org/wiki/Main_Page",
    goal: "Search Wikipedia for Ada Lovelace and confirm her article opens.",
    expect: { status: "succeeded", finalUrl: "/wiki/Ada_Lovelace" },
    covers: "Large page (snapshot compaction), search box with autocomplete",
  },
];
