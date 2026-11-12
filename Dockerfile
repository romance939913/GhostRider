# syntax=docker/dockerfile:1
ARG NODE_VERSION=26

# ---- base: Node + pinned pnpm (Node 25+ ships without corepack)
FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@12.18.0
WORKDIR /repo

# ---- build: install once, build everything, carve out deployables
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile
RUN pnpm build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @ghostrider/api --prod deploy /out/api && \
    pnpm --filter @ghostrider/db --prod deploy /out/db

# ---- runtime base: no pnpm, no source, non-root
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

FROM runtime AS migrate
COPY --from=build --chown=node:node /out/db ./
USER node
CMD ["node", "dist/run-migrations.js"]

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]

FROM runtime AS web
ENV PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]