# ADR-005: Data model and trace format are provisional until M1

- **Status:** Accepted
- **Date:** 2026-11-12
- **Deciders:** Brennan Romance

## Context

[`docs/data-model.md`](../data-model.md) describes the v1 tables: users, sites, journeys, journey versions, recordings, runs, step results, alert channels and credentials. Most of it follows from the product spec and is expected to hold.

The parts that depend on the agent do not. The **trace** (what the agent saw, did and why at each step) and the **compiled step** shape determine several columns, and the agent doesn't exist yet. The M1 spike builds it, and the trace format will change as the spike learns what the compiler (M2) actually needs.

Locking those shapes now, in migrations or in shared types, would mean writing and then undoing migrations for guesses.

## Decision

- The data model is **provisional until the M1 spike stabilizes the trace format**.
- Only the `users` table is migrated during M0. Other tables are added in the milestone that first needs them (M3 for journeys and runs).
- Agent-dependent fields stay loose: `jsonb` columns, or an S3 object referenced by a `*_key` column, with a `trace_format_version` field so old traces stay readable.
- At the end of M1, the trace becomes a **Zod schema in `packages/shared`** (the single source for types and runtime validation), and a new ADR records the locked format and supersedes this one.

## Consequences

**Positive**

- No premature migrations to reverse.
- The trace format is designed from what the agent actually produces, not from a guess.

**Negative**

- `data-model.md` will change after M1, and some of its agent-related sections should be read as a sketch until then.
- `jsonb` columns give up some database-level validation until the shape is pinned. Zod validation at the application boundary covers the gap.

## Alternatives considered

- **Design and migrate the full schema in M0.** Rejected: the most uncertain part of the schema would be fixed before the code that defines it exists.
- **Defer all data modeling until after M1.** Rejected: most of the schema doesn't depend on the trace, and the spec, architecture and job flow need it now.
