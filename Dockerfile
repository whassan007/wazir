# syntax=docker/dockerfile:1
# Multi-stage Dockerfile for Wazir
# Supports linux/amd64 and linux/arm64 (DGX Spark)

# --- Stage 1: Build & Bundle ---
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# Install build prerequisites
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY scripts/ ./scripts/

# Install dependencies and build bundle
RUN npm ci && npm run build

# --- Stage 2: Minimal Production Runtime ---
FROM node:22-bookworm-slim AS runtime

# OCI Image Annotations
LABEL org.opencontainers.image.title="Wazir" \
      org.opencontainers.image.description="Autonomous multi-agent AI coding harness and resource-governed fleet orchestrator" \
      org.opencontainers.image.url="https://github.com/whassan007/wazir" \
      org.opencontainers.image.source="https://github.com/whassan007/wazir" \
      org.opencontainers.image.vendor="Wazir Contributors" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

# Install production utilities (Git is required for worktree & agent coordination; curl/ca-certificates for HTTPS)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root system user and group
RUN groupadd -g 1000 wazir && \
    useradd -u 1000 -g wazir -m -s /bin/bash wazir

# Setup app directories
WORKDIR /home/wazir

# Install standalone bundled CLI
COPY --from=builder /build/bin/wa.js /usr/local/lib/wazir/wa.js
COPY README.md LICENSE /usr/local/lib/wazir/
RUN printf '#!/bin/sh\nexec node /usr/local/lib/wazir/wa.js "$@"\n' > /usr/local/bin/wa && \
    chmod +x /usr/local/bin/wa

# Entrypoint script
COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Persistent data directory
RUN mkdir -p /home/wazir/.wazir /home/wazir/.wazir/logs && \
    chown -R wazir:wazir /home/wazir

VOLUME ["/home/wazir/.wazir"]

# Expose API and Dashboard ports
EXPOSE 3000 3001

USER wazir
ENV HOME=/home/wazir \
    WAZIR_HOME=/home/wazir/.wazir \
    NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wa --version >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["api"]
