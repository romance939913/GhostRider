import { ARIA_ROLE_LIST } from "@ghostrider/shared";
import type { Page } from "playwright";

export { ARIA_ROLE_LIST };

/** An ARIA role as Playwright's getByRole accepts it. */
export type AriaRole = Parameters<Page["getByRole"]>[0];

/**
 * Used by the executor to reject unknown roles before Playwright sees them.
 * `new Set<AriaRole>` doubles as a compile-time check that every role in the
 * shared list is one Playwright accepts: a typo becomes a type error here.
 */
export const ARIA_ROLES: ReadonlySet<string> = new Set<AriaRole>(
  ARIA_ROLE_LIST,
);
