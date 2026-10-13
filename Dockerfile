# syntax=docker/dockerfile:1
#
# Multi-target build for the Wazir meta-harness. Build one of the runnable
# services with `--target`:
#
#   docker build --target api    -t wazir-api    .
#   docker build --target worker -t wazir-worker .
#   docker build --target web    -t wazir-web    .
#   docker build --target cli    -t wazir        .   # the `wa` CLI (default target)
#
# `docker-compose.yml` builds all of them from this same file. Multi-arch:
#   docker buildx build --platform linux/amd64,linux/arm64 --target cli .
#
# Final images contain production dependencies only, run as the unprivileged `node` user,
# keep all state in /data (WAZIR_HOME; mount a volume there), and run under tini so SIGTERM
# reaches node and the container stops cleanly.

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS builder
# node-pty (a dependency of @wazir/tools) has no musl prebuild and compiles from source.
RUN apk add --no-cache python3 make g++ linux-headers
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts/bundle.mjs ./scripts/bundle.mjs
RUN npm ci --no-audit --no-fund
RUN npm run build

# Production dependencies and built output only (no TypeScript sources, tests or dev tools).
FROM builder AS prod
RUN npm prune --omit=dev --no-audit --no-fund \
 && find packages apps -type d \( -name src -o -name tests -o -name test \) -not -path '*/dist/*' -not -path '*/node_modules/*' -prune -exec rm -rf {} + \
 && find packages apps -name '*.tsbuildinfo' -delete \
 && rm -rf scripts tsconfig.json tsconfig.base.json /root/.npm

FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache tini git \
 && mkdir -p /data \
 && chown node:node /data
ENV NODE_ENV=production \
    WAZIR_HOME=/data
WORKDIR /app
COPY --from=prod --chown=node:node /app /app
VOLUME ["/data"]
USER node
ENTRYPOINT ["/sbin/tini", "--"]

# ---- API server -------------------------------------------------------
FROM runtime AS api
ENV PORT=4800
# The API defaults to binding 127.0.0.1, which is correct for a bare-metal
# install but unreachable from outside a container (Docker's port mapping
# forwards to the container's external interface, not its loopback) — must
# bind all interfaces here. Because of that, `apps/api/src/main.ts` refuses
# to start on a non-loopback bind unless WAZIR_API_TOKEN is set (or
# WAZIR_ALLOW_UNAUTHENTICATED=1 is passed explicitly); docker-compose.yml
# supplies the token and publishes the port on the host's loopback only.
ENV WAZIR_HOST=0.0.0.0
EXPOSE 4800
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4800)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/api/dist/main.js"]

# ---- Worker daemon ------------------------------------------------------
FROM runtime AS worker
CMD ["node", "apps/worker/dist/index.js"]

# ---- Web dashboard --------------------------------------------------------
FROM runtime AS web
ENV PORT=4801
EXPOSE 4801
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4801)+'/').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]

# ---- CLI (`docker run --rm -v wazir:/data ghcr.io/whassan007/wazir doctor`) --------------
FROM runtime AS cli
ENTRYPOINT ["/sbin/tini", "--", "node", "/app/bin/wa.js"]
CMD ["--help"]
