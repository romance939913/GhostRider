# GhostRider

![Status: in active development](https://img.shields.io/badge/status-in%20active%20development-orange)

**AI-authored synthetic monitoring for small teams.** Describe a critical user journey in plain English, like _"sign up with a new email and confirm the dashboard loads."_ An AI browser agent performs it once, and GhostRider compiles what it did into a deterministic Playwright script. That script replays on a schedule **with no AI in the loop**, and you get alerted, with a screenshot, the moment the journey breaks.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) 26 (see `.nvmrc`)
- [pnpm](https://pnpm.io/) 12: `npm install -g pnpm`
- [Docker](https://www.docker.com/) with Docker Compose

### Run it locally

```bash
git clone https://github.com/romance939913/GhostRider.git
cd GhostRider
nvm use                      # switches to Node 26
pnpm install
cp .env.example .env         # local defaults work as-is

docker compose up -d         # starts Postgres and Redis
pnpm build                   # builds the shared packages the API depends on
pnpm --filter @ghostrider/db db:migrate
pnpm --filter @ghostrider/api dev
```

Check that everything is connected:

```bash
curl -i localhost:4000/health
# HTTP/1.1 200 OK
# {"status":"ok","checks":{"postgres":"ok","redis":"ok"},...}
```

If Postgres or Redis is down, `/health` returns `503` and names the dependency that failed.

### Useful commands

| Command               | What it does                                            |
| --------------------- | ------------------------------------------------------- |
| `pnpm build`          | Build every package (cached by Turborepo)               |
| `pnpm test`           | Run all tests (Vitest)                                  |
| `pnpm typecheck`      | Type-check every package                                |
| `pnpm lint`           | Lint and check formatting (Biome)                       |
| `pnpm format`         | Fix formatting automatically                            |
| `docker compose down` | Stop Postgres and Redis (add `-v` to delete their data) |

## Repository layout

```
apps/
  api/           Fastify API (/health so far)
packages/
  shared/        Zod schemas shared across apps
  db/            Drizzle schema, migrations and migration runner
docs/            Product spec, architecture, data model, ADRs
```

## Design docs

- [v1 product spec](docs/v1-product-spec.md): what v1 does, and deliberately doesn't do
- [Architecture](docs/architecture.md): system diagram, components, job flow, security boundaries
- [Data model](docs/data-model.md): tables, retention and screenshot storage
- [Architecture decision records](docs/adr/)
