# syntax=docker/dockerfile:1

# TypeScript is intentionally executed through tsx at runtime for the API,
# scheduler, and Drizzle migrations. Keep the workspace sources and pnpm layout
# in the runtime image rather than producing incomplete standalone bundles.
FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production

RUN npm install --global pnpm@11.24.0
WORKDIR /app

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/probe-worker/package.json apps/probe-worker/package.json
COPY apps/scheduler/package.json apps/scheduler/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/notifications/package.json packages/notifications/package.json
COPY packages/regions/package.json packages/regions/package.json
RUN pnpm install --frozen-lockfile

FROM dependencies AS workspace

COPY . .

FROM workspace AS api

CMD ["pnpm", "--filter", "@uptime/api", "start"]

FROM workspace AS scheduler

CMD ["pnpm", "--filter", "@uptime/scheduler", "start"]

FROM workspace AS migrate

CMD ["pnpm", "--filter", "@uptime/database", "migrate"]

FROM workspace AS web

# Vite writes a short-lived bundled-config module and dependency cache while it
# serves development assets. The other runtime targets remain read-only.
RUN chown -R node:node /app
ENV NODE_ENV=development

CMD ["pnpm", "--filter", "@uptime/web", "dev", "--host", "0.0.0.0", "--port", "5176"]
