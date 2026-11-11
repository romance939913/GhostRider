# ADR-004: Postgres for state; Redis + BullMQ for jobs and schedules

- **Status:** Accepted
- **Date:** 2026-11-10
- **Deciders:** Brennan Romance

## Context

GhostRider needs durable state (users, journeys, journey versions, runs, step results) and background work:

| Queue    | Produced by                 | Consumed by     |
| -------- | --------------------------- | --------------- |
| `record` | API                         | Recorder worker |
| `run`    | Scheduler / API ("run now") | Runner worker   |
| `alert`  | Runner worker               | Notifier worker |

Background work needs at-least-once delivery, retries with backoff, recovery when a worker crashes mid-job, concurrency limits (browsers are expensive), and **recurring schedules** per journey ("every 15 minutes"). The system is all TypeScript (ADR-002).

## Decision

- **Postgres** (with Drizzle) is the **only source of truth**.
- **Redis + BullMQ** run all background work:
  - one queue per job type (`record`, `run`, `alert`), payloads validated with shared Zod schemas;
  - journey schedules as BullMQ **job schedulers** (`upsertJobScheduler`, keyed by journey ID), so no separate cron service;
  - retries with exponential backoff for _infrastructure_ failures (see "two kinds of retry" in the architecture doc);
  - stalled-job detection to recover from crashed workers;
  - per-queue concurrency limits sized to browser capacity.
- Redis also carries recording-progress events (BullMQ `QueueEvents`) and demo rate-limit counters.

**Handling the dual write.** A run is stored in Postgres and its job in Redis, and the two can't share a transaction. So:

1. Commit the Postgres row first, then enqueue.
2. Use the run ID as the BullMQ **job ID**, so enqueueing the same run twice is a no-op.
3. A **reconciliation sweep** (a repeatable BullMQ job) re-enqueues runs stuck in `queued` past a threshold.
4. On API startup, schedules are **rebuilt from the `journeys` table**, so a wiped Redis loses nothing permanent.

## Consequences

**Positive**

- Mature, well-documented building blocks: retries, backoff, stalled jobs, schedules, rate limits and progress events come built in.
- Redis + BullMQ are common in industry, and learning them in depth was a goal.
- Fast queue operations that don't load the main database.
- Bull Board can give a free admin view of the queues.

**Negative**

- **One more service** to run, monitor and pay for (Redis).
- **No atomic enqueue.** Handled by commit-then-enqueue, idempotent job IDs and the reconciliation sweep. These have to be tested deliberately, including "Redis down during enqueue."
- Redis persistence must be configured (AOF) so queued jobs survive a restart. Even without it, the sweep and schedule rebuild recover everything.

## Alternatives considered

- **Postgres as the queue** (`jobs` table, `FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY`, leases). Gives atomic enqueue and one less service, and works across languages. Rejected because we'd hand-build retries, backoff, leases, scheduling and dead-lettering that BullMQ already provides, and because Redis experience was an explicit goal. It remains a credible option if Redis ever becomes the operational pain point.
- **pg-boss** (Node, Postgres-backed). Same trade-offs as above, with a library doing the work.
- **NATS JetStream / RabbitMQ.** Strong brokers, but more to operate and with weaker scheduling features than BullMQ. Unnecessary at this scale.
- **A cloud queue (SQS + EventBridge Scheduler).** Ties local development to AWS emulation and adds vendor lock-in before it's needed.
