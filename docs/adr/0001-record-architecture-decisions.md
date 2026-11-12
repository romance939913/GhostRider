# ADR-001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Brennan Romance

## Context

GhostRider is a solo project built at about 10 hours a week over several months. Decisions made in week 1 (stack, data ownership, where AI runs) shape everything after them, and the reasons behind them are easy to forget or to re-argue later. Anyone reading the repo, including reviewers and interviewers, needs the _why_ behind the design as well as the code.

## Decision

Record significant decisions as **Architecture Decision Records** in `docs/adr/`, in the format Michael Nygard described:

- One Markdown file per decision, numbered in order (`0001-…`, `0002-…`).
- Sections: Status, Date, Deciders, Context, Decision, Consequences, Alternatives considered.
- An accepted ADR is **not edited** to change the decision. A new ADR replaces it, with status `Supersedes ADR-00X`, and the old one is marked `Superseded by ADR-00Y`. Typo and link fixes are fine.
- A decision is "significant" if it is expensive to reverse or if a reasonable engineer could have chosen differently: stack, storage, data ownership, security boundaries, where AI is allowed to run.

[`docs/adr/README.md`](./README.md) indexes every ADR and its status.

## Consequences

**Positive**

- The design history lives next to the code, is versioned with it, and is reviewed in the same pull requests.
- Rejected alternatives are written down, so they aren't re-proposed without new information.

**Negative**

- A small writing cost per decision. Kept short: ADR-002 is about the upper bound on length.

## Alternatives considered

- **No written decisions.** Rejected: the reasoning would live only in chat history and memory.
- **A single design doc that gets edited over time.** Rejected: editing in place loses _when_ and _why_ a decision changed. The living docs (`architecture.md`, `data-model.md`) describe the current state, and ADRs record how it got there.
