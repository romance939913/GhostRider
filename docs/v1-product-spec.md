# GhostRider — v1 Product Spec

> **Status:** Draft v0.1 · **Owner:** Brennan Romance · **Last updated:** 2026-11-10
> Related: [Architecture](./architecture.md) · [ADRs](./adr/) · Milestones (M0–M8)

## 1. Summary

GhostRider is synthetic monitoring for small teams. You describe a critical user journey in plain English ("sign up with a new email and confirm the dashboard loads"). An AI browser agent performs it once, and GhostRider compiles what the agent did into a deterministic Playwright script. That script then runs on a schedule **with no LLM in the loop**, and you get alerted, with a screenshot, the moment the journey breaks.

**The core bet:** AI is good at _figuring out_ how to do a task and too slow, expensive and nondeterministic to run every few minutes. So GhostRider uses AI once, at authoring time, and runs plain code at check time.

## 2. Problem

Small SaaS teams find out their signup or checkout is broken when a customer emails them, or worse, when nobody does. Existing options don't fit them well:

- **Uptime pingers** (status-code checks) say the homepage returned 200 while the signup button throws a JS error.
- **Hand-written Playwright/Cypress monitors** work, but someone has to write and maintain them. Small teams don't.
- **Enterprise synthetic monitoring and AI-QA suites** are priced and designed for QA departments and pre-deploy test suites, not a two-person team watching production.

## 3. Target user

**Primary:** a solo founder or a small team (1–10 engineers) running a web SaaS in production. They know what their critical journeys are, don't have a QA person, and want a "tell me when signup breaks" alarm in under 10 minutes of setup.

**Not the target (v1):** QA teams that want a pre-deploy regression suite, enterprises that need SSO, audit logs or private-network runners.

## 4. How it works (core loop)

```
Describe ──► Record ──► Compile ──► Replay on schedule ──► Alert
(English)   (AI agent)  (trace →     (Playwright only,       (Slack/email
                         script)      no LLM)                  + screenshot)
```

1. **Describe:** the user enters a URL and a goal in English, plus optional test credentials.
2. **Record:** the agent drives a real browser through the accessibility tree using a small tool set (`click`, `type`, `navigate`, `assert`, `done`). Every step is logged to a **trace**: what it saw, what it did, why, and what happened.
3. **Compile:** the trace becomes a deterministic Playwright script with stable selectors, explicit assertions and the original English intent stored on every step. The user reviews it and activates it.
4. **Replay:** a worker runs the compiled script on a schedule in a sandboxed browser and records the result of every step. Screenshots and a Playwright trace are kept when a run fails, plus the most recent passing run as a "known good" reference.
5. **Alert:** on failure, the run is retried once. If it still fails, the user gets an alert showing the failing step, its intent, the error and a screenshot.

## 5. v1 scope

### 5.1 Journey authoring

- Create a journey from a **start URL + English goal**.
- The agent records the journey in a real Chromium browser and streams progress to the UI.
- Supported actions: navigate, click, type/fill, select, wait-for, and **assert**.
- Assertions:
  - **UI:** text visible, element visible/enabled, URL matches.
  - **Network:** a request matching a pattern returned a 2xx status (e.g. `POST /api/signup → 201`).
- **Value chaining:** steps can generate a value and reuse it later (e.g. sign up as `ghost+{{run.id}}@…`, then assert that email shows on the profile page).
- **Test credentials:** stored encrypted and referenced in steps as variables (`{{secrets.password}}`). **Secret values are never sent to the LLM**; the agent only sees the placeholder.
- If the agent can't complete the goal, the user sees the trace and why it failed, not a silent bad script.

### 5.2 Compilation

- Trace → Playwright script (TypeScript).
- **Selector priority:** `getByRole`/`getByLabel`/`getByTestId` → visible text → CSS as a last resort. Each step records its chosen selector and fallbacks.
- Each compiled step stores: action, selector, value or variable, assertion, and the **English intent** ("click the Sign up button").
- The compiled script is versioned. Re-recording a journey creates a new version; old runs stay linked to the version they ran.
- **Bar for "compiled correctly":** 10 consecutive green replays with zero LLM calls.

### 5.3 Scheduled replay

- Schedules: every 5, 15 or 60 minutes, or manual "run now".
- Each run executes in an isolated, containerized Chromium with a hard timeout (proposed: 60s per journey).
- Every run records each step's result (pass/fail, timing, error).
- **Screenshots and the Playwright trace file are kept only for failed runs, plus the most recent passing run of each journey.** That passing run is the "known good" reference to compare a failure against. When the next run passes, it replaces the previous one. Stored in S3-compatible storage.
  - _Why:_ a screenshot of every step of every run would be about 29 GB/day at 100 users × 3 journeys every 15 min, almost all of it images of things working. This policy cuts that by more than 99% and keeps everything useful for debugging.
- Run statuses: `queued → running → passed | failed | errored` (`errored` = GhostRider's own fault, such as a worker crash, and never alerted as a site failure).

### 5.4 Alerts

- Channels: **Slack** (incoming webhook) and **email**.
- An alert fires when a run fails _after one automatic retry_, to cut flaky noise.
- The alert includes: journey name, failing step number and intent, error message, a failure screenshot and a link to the run.
- A **recovery** notice is sent when a failing journey passes again. No repeat alerts while a journey stays down.

### 5.5 Dashboard

- Journey list with current status, last run time and pass rate (7 days).
- Run history per journey.
- **Step replay viewer:** step-by-step list with intent, action and result for any run, plus screenshots for failed runs and the latest passing run.

### 5.6 Accounts & safety

- Email/password or GitHub sign-in. One user per account in v1.
- **Domain verification** (DNS TXT record or meta tag) is required before a journey can run on a schedule. Unverified domains can be recorded and run manually only. This stops GhostRider from being used to hammer sites the user doesn't own.
- Free-tier limits (proposed): 3 journeys, minimum 15-minute interval.
- **Landing-page demo:** visitors can watch the agent record a journey on a GhostRider-owned demo site. Rate-limited per IP, with a global daily LLM spend cap.

## 6. Non-goals (v1)

These are deliberately out of scope. Most are reasonable later additions; none are needed to prove the core loop.

| Non-goal                                      | Why not now                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **AI self-healing** of broken scripts         | Phase 2 (M6). v1 must first prove deterministic replay is reliable on its own.                    |
| Firefox / WebKit / mobile browsers            | Chromium covers the core use case; multi-browser multiplies the test matrix.                      |
| Teams, roles, SSO, audit logs                 | Single-user accounts are enough to prove value to the target user.                                |
| Visual regression / pixel diffing             | Different product; noisy; assertions cover functional breakage.                                   |
| CI / pre-deploy test runs                     | GhostRider monitors **production**; it isn't a QA suite.                                          |
| Multi-region runners                          | One region is fine for "is the journey broken." Latency monitoring is a different product.        |
| Journeys behind CAPTCHA, email OTP or SMS MFA | Hard and adversarial by design. Users can whitelist the runner or use a test account without MFA. |
| Editing compiled scripts by hand              | v1 users re-record instead; a script editor is a lot of UI for little value.                      |
| Paid plans / billing                          | Portfolio project with a free tier.                                                               |

## 7. Product principles

1. **AI at authoring, code at runtime.** Scheduled runs never call an LLM. That keeps runs cheap, fast, reproducible and debuggable.
2. **Never hide a real failure.** A false "all green" is worse than a false alarm. Whenever the system has to choose, it alerts. (This matters most in Phase 2 self-healing, where any heal is always disclosed.)
3. **Secrets never reach the model.** Credentials are encrypted at rest, injected only at execution time, and redacted from traces, logs and screenshots where feasible.
4. **Only monitor what you own.** Domain verification gates scheduled runs.
5. **Every step explains itself.** The stored English intent turns "selector `#btn-3` not found" into "couldn't click _Sign up_."

## 8. Success criteria

| Area        | Measure                                                            | v1 target                                       |
| ----------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| Authoring   | Agent completes journeys in the eval set (5–10 real-site journeys) | ≥ 80%                                           |
| Compilation | Compiled script replays green consecutively                        | 10/10, zero LLM calls                           |
| Detection   | Deliberately broken dogfood journey → alert received               | Within one schedule interval                    |
| Noise       | False alerts on healthy journeys (dogfood, 1 week)                 | < 1% of runs                                    |
| Cost        | LLM cost per journey authored; cost per scheduled run              | Measured and published; run cost ≈ compute only |
| Dogfooding  | SupportSense AI monitored in production                            | ≥ 2 journeys live                               |

## 10. Risks & open questions

| Risk / question                                                           | Mitigation / next step                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Agent reliability on real-world sites (modals, cookie banners, SPAs)      | M1 spike runs first, measured against the eval set. Screenshots only as a fallback to the accessibility tree. |
| Compiled selectors are brittle                                            | Role/label/testid-first selector strategy and stored fallbacks; flakiness tracked per step.                   |
| Abuse: using GhostRider to scrape or load-test sites                      | Domain verification, rate limits, minimum intervals.                                                          |
| Running arbitrary websites in our infrastructure                          | Sandboxed, ephemeral browser containers with no access to internal network or secrets beyond the run's own.   |
| Trace format isn't known until M1                                         | Data model stays provisional (ADR-005); trace stored as versioned JSON.                                       |
| **Open:** how journeys that need a fresh account each run should clean up | Decide in M2. Likely value chaining plus a user-provided teardown step, or a dedicated test account.          |
| **Open:** default model for authoring                                     | Decided by evals in M7; any reasonable model for M1.                                                          |

## 11. Glossary

- **Journey:** a critical path through your app to monitor, such as signup or checkout (URL + English goal).
- **Trace:** the agent's step-by-step recording of a journey, including observations and reasoning.
- **Compiled script / journey version:** the deterministic Playwright program produced from a trace.
- **Run:** one execution of a journey version.
- **Intent:** the plain-English description of what a step is trying to do.
