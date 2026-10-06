# syntax=docker/dockerfile:1

# Hosted API on Node. Build from the repository root:
#   docker build -f deploy/docker/api-node.Dockerfile -t uptime-api-node .
#
# The runtime image holds one bundled file and no node_modules. The bundle is
# plain JavaScript, so it does not depend on the architecture of the build host.
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN npm install --global pnpm@11.24.0
WORKDIR /app

COPY . .
# Install scripts are skipped: esbuild ships its binary as an optional package
# and nothing else in this filter needs a postinstall step.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @uptime/api-worker... \
    && pnpm --filter @uptime/api-worker build:node

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/apps/api-worker/dist/node/server.mjs ./server.mjs

USER node
EXPOSE 8787

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=6 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# SIGTERM triggers a graceful drain; keep the init process out of the way.
STOPSIGNAL SIGTERM
CMD ["node", "server.mjs"]
