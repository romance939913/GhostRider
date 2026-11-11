# ADR-002: All-TypeScript monorepo

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Brennan Romance

## Context

GhostRider has two kinds of work:

1. **Browser work:** driving Chromium with an AI agent (recording) and replaying compiled scripts (runs). This is built on Playwright, whose first-class runtime is Node.js. The compiler's output is a TypeScript Playwright script, so whatever executes journeys must run Node.
2. **Control work:** an HTTP API, auth, scheduling, and alert fan-out to Slack and email.

The browser work fixes TypeScript for the execution side. The open question was whether the control side should also be TypeScript or a second language.

It's a solo project at about 10 hours/week, so time to a working v1 matters. The trace format, job payloads and API types are shared by almost every component.

## Decision

Use **TypeScript for every component**, in a single **pnpm + Turborepo** monorepo:

- `apps/web`: Next.js
- `apps/api`: Fastify, Drizzle ORM
- `apps/worker`: recorder, runner and notifier roles (Playwright)
- `packages/agent`, `packages/compiler`, `packages/db`
- `packages/shared`: **Zod** schemas for the trace format, job payloads and API types

Tooling: Biome (lint + format), Vitest (tests), `tsc --noEmit` (typecheck), all run through Turborepo with caching.

## Consequences

**Positive**
- **One type system end to end.** A Zod schema in `packages/shared` gives static types *and* runtime validation everywhere, with no code generation step.
- **First-class Playwright** with no cross-language boundary.
- **BullMQ is available** (Node-only), with retries, schedules and stalled-job recovery built in (see ADR-004).
- **One toolchain** in CI, Docker and local dev, so M0 setup and ongoing upkeep are both smaller.

**Negative**
- The API and scheduler run on Node's single-threaded event loop. Fine at v1 scale; CPU-heavy work stays out of the API.
- Less range shown across languages. Accepted: the project's emphasis is the system design and AI work, not language variety.

## Alternatives considered

- **Go control plane + TypeScript execution plane**, with Postgres as a cross-language job queue (`FOR UPDATE SKIP LOCKED`). A defensible split: Go suits concurrent I/O, and the queue would make enqueue atomic with the database write. Rejected in favor of one language, faster delivery, and using Redis + BullMQ, which are widely used in industry and were a goal to learn in depth. It would have added two toolchains and OpenAPI/JSON Schema code generation to keep the languages in sync.
- **All Go** (playwright-go). Rejected: the community port lags upstream, and compiled scripts are TypeScript Playwright, so Node is needed at execution time anyway.
- **Python for the API** (as in SupportSense AI). Rejected: it adds a second language with no technical gain, and repeats the stack of an existing portfolio project.
