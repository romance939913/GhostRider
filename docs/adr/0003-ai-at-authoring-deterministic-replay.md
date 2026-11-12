# ADR-003: AI at authoring time, deterministic replay at run time

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Brennan Romance

## Context

GhostRider monitors critical user journeys (signup, login, checkout) on a schedule, typically every 5–15 minutes, and alerts when one breaks.

AI browser agents are good at _figuring out_ how to complete a goal on an unfamiliar site from a plain-English description. They are also:

- **Slow:** each step is a model call over the page's accessibility tree, so a journey takes tens of seconds to minutes.
- **Expensive:** cost scales with steps × runs. One journey every 5 minutes is about 8,600 runs a month.
- **Nondeterministic:** the same goal can take a different path, or fail, from run to run.

A monitor's value depends on trust. A check that fails at random produces false alerts, and teams learn to ignore it, which is worse than having no monitor. Monitoring needs the opposite of the agent's properties: cheap, fast and repeatable, so that a failure means the site broke.

## Decision

Use the LLM **only at authoring time**. Run plain code at check time.

1. **Record:** an AI agent performs the journey once, driving a real browser through the accessibility tree with a small tool set (`click`, `type`, `navigate`, `assert`, `done`). Every step is logged to a trace.
2. **Compile:** the trace is compiled into a deterministic Playwright script with stable selectors (role, label or test ID before CSS), explicit assertions, and the original English intent stored on each step. The user reviews it before activating it.
3. **Replay:** scheduled runs execute that script with **zero LLM calls**.

This is enforced by the architecture, not just a convention: the **runner worker has no LLM credentials**. Only the recorder worker holds an LLM API key (see [architecture.md](../architecture.md) §2).

In Phase 2 (M6), AI returns in one narrow place: **diagnosing a run that has already failed after a retry**. It classifies the failure as "site broken" (alert) or "UI changed, intent still achievable" (repair). Every repair is disclosed to the user; there are no silent heals.

## Consequences

**Positive**

- **Cost per run ≈ a plain Playwright run.** LLM cost scales with the number of journeys authored, not with how often they run.
- **Deterministic results.** The same site state gives the same result, so a red run means something changed.
- **Fast checks**, which allows short intervals and quick retries.
- **Reviewable and portable.** The compiled script is ordinary Playwright that a user can read and that would run without GhostRider.
- **A smaller security surface on the high-volume path.** The runner never sends page content or credentials to a third-party model.

**Negative**

- **The compiler is the hard part.** Selector choice, value chaining (for example, a generated email reused in a later step) and assertion inference all have to be right for replays to be stable (M2).
- **UI changes break compiled scripts** until a journey is re-recorded, or until M6's diagnosis and repair exists. A deliberate redesign of a page will cause failures.
- **Two code paths to maintain:** the agent and the compiler.

## Alternatives considered

- **Run the agent on every check.** Rejected: cost × frequency, minutes per run, and nondeterministic results that would cause false alerts.
- **Record-and-replay without AI** (browser-extension recorders that capture clicks). Rejected: no plain-English authoring, recorded selectors tend to be brittle, and there is nothing to help when the UI changes.
- **Hand-written Playwright monitors.** These work, and they're what GhostRider compiles to, but someone has to write and maintain them. Removing that work is the product.
- **Use AI to generate a script from the English description alone, without running the journey.** Rejected: without actually performing the journey against the live site, the script is a guess. The recorded trace is evidence that the steps work.
