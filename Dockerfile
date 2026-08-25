# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# Multi-stage Dockerfile for Ontology Engine
#
# Base image note: we use Debian "slim" (glibc), NOT Alpine (musl). The
# @temporalio/core-bridge native addon ships glibc-only prebuilt binaries for
# Linux (it calls glibc symbols such as __register_atfork). On a musl base the
# addon fails to load at startup with ERR_DLOPEN_FAILED ("symbol not found"),
# crash-looping the app. glibc is Temporal's officially supported runtime.
# ---------------------------------------------------------------------------

# Stage 1 — Build
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# pnpm is the single source of truth (CI is pnpm-native); enable via corepack
# and pin to the v10 line so the scanned/installed tree matches what ships.
RUN corepack enable && corepack prepare pnpm@latest-10 --activate

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN --mount=type=cache,id=tellus-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm config set fetch-retries 5 \
    && pnpm install --frozen-lockfile --ignore-scripts

COPY src/ src/
COPY scripts/ scripts/
# tsc emits only .js; build:copy-assets ships the runtime non-TS assets — crucially
# src/migrations/*.sql (the migration ledger + forward SQL) and src/templates. Without this
# the prod image has ZERO .sql migrations and the migration gate fails at boot.
RUN pnpm exec tsc && bash scripts/copy-assets.sh

# Stage 2 — Production
FROM node:24-bookworm-slim

WORKDIR /app

# curl: used by the compose healthcheck (GET /api/v1/health).
# ca-certificates: TLS trust store for outbound HTTPS (e.g. AWS SDK / S3).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest-10 --activate

# Run as non-root user for security (Debian useradd/groupadd, not Alpine's).
# `--create-home` is required: DuckDB resolves its extension/cache directory
# through the current user's home and rejects a passwd entry whose home path
# does not exist. Keep DuckDB's state in the application data directory too,
# rather than relying on an ambient host home directory.
RUN groupadd --system appgroup \
    && useradd --system --create-home --gid appgroup appuser

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=tellus-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm config set fetch-retries 5 \
    && pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm rebuild duckdb

COPY --from=builder /app/dist/ dist/

# Create data directories for datasource files and DuckDB's extension/cache
# home. `appdata` is the persistent application volume in Compose.
RUN mkdir -p /app/data/duckdb /tmp/duckdb_spill \
    && chown -R appuser:appgroup /app/data /tmp/duckdb_spill

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV DATA_DIR=/app/data
ENV HOME=/home/appuser
ENV DUCKDB_HOME_DIRECTORY=/app/data/duckdb

CMD ["node", "dist/server.js"]
