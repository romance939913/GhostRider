# ADR-006: Trace format v1

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Brennan Romance
- **Supersedes:** [ADR-005](./0005-provisional-data-model-and-trace-format.md)

## Context

[ADR-005](./0005-provisional-data-model-and-trace-format.md) kept the trace format provisional until the M1 agent spike had shown what a trace really needs to contain.

M1 built the recording agent as a loop: observe the page (a compacted, redacted ARIA snapshot), ask the model for one action, execute it with Playwright, and record the step. It was measured against an eval set of 8 journeys on public test sites, including one that must fail. The eval runs drove the last changes to the format (a `select` action, a `fieldValue` assertion, cache token counts). After that, traces from the final eval runs parsed unchanged against the schema in this ADR, apart from the version number.

The trace is the contract between the agent (M1), the compiler (M2), storage (M3) and the replay viewer (M4), so it should now stop moving.

## Decision

The trace format is **locked as v1**, defined once as Zod schemas in [`packages/shared/src/trace.ts`](../../packages/shared/src/trace.ts). Those schemas are the only definition: they give both the TypeScript types and runtime validation.

A trace is a header (goal, start URL, model, timestamps), an outcome, a list of steps and token totals. Each step records **observation → thought → intent → action → result → usage**.

### What's locked, and why

1. **Elements are targeted only by ARIA role + accessible name, plus `nth` for duplicates.** `role` is an enum of ARIA roles. This maps one-to-one onto Playwright's `getByRole`, so the trace already holds the stable selector the compiler needs. Duplicates without `nth` are an `ambiguous_target` error, never "pick the first", because a compiled script must hit the same element on every run. Names match exactly, except for icon-font glyphs (Unicode Private Use Area characters) and surrounding whitespace. The matcher lives in `packages/agent/src/names.ts`, and the compiler must use the same one.
2. **Six actions:** `navigate`, `click`, `select`, `type`, `assert`, `done`. **Four assertions:** `textVisible`, `elementVisible`, `fieldValue`, `urlMatches`.
3. **`intent` is separate from `thought`.** `intent` is a short imperative that describes exactly what the step does ("Click the Login button"). It's stored on every compiled step and shown in alerts. `thought` is free-form reasoning, kept for debugging only.
4. **Failures are data.** A failed step is `{ ok: false, error: { code, message } }`, with codes from a fixed list (`element_not_found`, `ambiguous_target`, `timeout`, `navigation_failed`, `assertion_failed`, `invalid_action`). The model reads them to recover, and M6 diagnosis builds on them.
5. **Secrets never appear in a trace.** Actions hold placeholders (`{{secrets.password}}`). Observations are redacted before they reach the model or the trace: known secret values become their placeholders, and every password field's value is masked.
6. **Outcomes:** `succeeded`, `failed`, `step_limit`, `budget_exceeded`, `error`. The schema requires a `succeeded` trace to end with `done(success: true)`, and the agent loop only accepts that once an assert has passed. Evals also check that a passing assert actually proves the goal.
7. **Observations store what the model saw:** the compacted snapshot, the size of the raw snapshot, and whether it was truncated.
8. **Usage is recorded per step and in total**, including prompt-cache read and write tokens, plus the cost when the model's price is known.

### Versioning

`traceFormatVersion` is the literal `1`. Adding an optional field doesn't change the version. A breaking change bumps it, and readers upgrade older versions when they load them. Version 0 traces only ever existed on development machines and aren't supported; they're shape-compatible anyway.

## Consequences

**Positive**

- One definition shared by every package that touches traces, so M2 can be built against a stable contract.
- Storage stays simple, as planned in the data model: a recording's full trace is JSON in S3 (`recordings.trace_key`), and Postgres keeps only summary columns.
- Recordings are measured, not anecdotal: on the eval set, 7/8 at $0.64 per full run before the M1 fixes, and 8/8 at $0.20 after them, with every success proven by an assert that matches the goal. Most of the saving comes from prompt caching on the tools and system prompt.

**Negative**

- Exact names make recordings sensitive to copy changes: renaming "Log in" to "Sign in" breaks the selector. That's deliberate. A changed UI should alert, until M6 adds disclosed self-healing.
- Traces contain page content (snapshots), so they're user data: they follow the retention rules in the data model and are git-ignored locally.
- The role list must stay in sync with Playwright's. A compile-time check in `packages/agent` enforces it.

**Known follow-ups**

- The agent sometimes adds a weaker assert before a stronger one (`"item left"`, then `"1 item left"`). The compiler should drop asserts that a later one covers.
- Custom (non-native) dropdowns rely on click sequences, and content inside iframes isn't observed yet (Playwright's `ariaSnapshot({ mode: "ai" })` would include it).

## Alternatives considered

- **CSS selectors or per-snapshot element refs as targets.** Refs only mean something within one snapshot, so they can't be replayed. CSS selectors are brittle and hard for a model to produce reliably. Role + name is both stable and readable.
- **Storing the full raw snapshot on every step.** Wikipedia's raw snapshot is over 200,000 characters. The compacted snapshot plus its original size is enough to debug a recording; screenshots for the replay viewer come in M4.
- **Storing the provider's conversation transcript instead of steps.** That ties the format to one LLM provider's message format and repeats every page snapshot. The agent instead sends one stateless request per step, and the trace records steps.
- **JSON Schema as the source of truth.** Zod gives types and validation from one definition. The tool schemas sent to the model are written separately, within strict tool use's limits, and every tool call is validated against the Zod schema.
