# syntax=docker/dockerfile:1
#
# Multi-target build for the Wazir meta-harness. Build one of the runnable
# services with `--target`:
#
#   docker build --target api    -t wazir-api    .
#   docker build --target worker -t wazir-worker .
#   docker build --target web    -t wazir-web    .
#
# `docker-compose.yml` builds all three from this same file. This ships the
# full npm workspace (all packages + devDependencies) in the final image
# rather than a pruned/slimmed one — correct and simple over minimal image
# size, matching the scope of the rest of this remediation pass.

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm ci
RUN npm run build

# ---- API server -------------------------------------------------------
FROM builder AS api
ENV NODE_ENV=production
ENV PORT=4800
# The API defaults to binding 127.0.0.1, which is correct for a bare-metal
# install but unreachable from outside a container (Docker's port mapping
# forwards to the container's external interface, not its loopback) — must
# bind all interfaces here.
ENV WAZIR_HOST=0.0.0.0
EXPOSE 4800
CMD ["node", "apps/api/dist/main.js"]

# ---- Worker daemon ------------------------------------------------------
FROM builder AS worker
ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/index.js"]

# ---- Web dashboard --------------------------------------------------------
FROM builder AS web
ENV NODE_ENV=production
ENV PORT=4801
EXPOSE 4801
CMD ["node", "apps/web/server.js"]

# ---- CLI (run one-off commands: `docker compose run --rm cli wazir ...`) --
FROM builder AS cli
ENV NODE_ENV=production
ENTRYPOINT ["node", "apps/cli/dist/index.js"]
CMD ["--help"]
