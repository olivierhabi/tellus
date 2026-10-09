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

# DuckDB CLI (out-of-process merge engine). The production funnel profile
# enables the out-of-process merge (src/services/funnel/mergeCliRunner.ts
# spawns `duckdb` with a SQL script so a merge OOM kills the child, not the
# API/worker), so the CLI must ship in the runtime image. Fetched here in the
# throwaway builder stage (keeps curl/unzip out of the runtime image), pinned
# to the same version as the `duckdb` node binding and verified against the
# release SHA-256 so a tampered or re-tagged asset fails the build.
ARG TARGETARCH
ARG DUCKDB_CLI_VERSION=1.4.4
ARG DUCKDB_CLI_SHA256_AMD64=ea79eae4233f1aba9a020c8a61877de38a789bc62cdd37485d3589cd77dc0d3e
ARG DUCKDB_CLI_SHA256_ARM64=97995363217ddef691fe53b26df3b55ff368d356613d9daaea5999bb7a637e60
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/* \
    && arch="${TARGETARCH:-amd64}" \
    && case "$arch" in \
         amd64) sha="$DUCKDB_CLI_SHA256_AMD64" ;; \
         arm64) sha="$DUCKDB_CLI_SHA256_ARM64" ;; \
         *) echo "unsupported TARGETARCH=$arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 5 -o /tmp/duckdb.zip \
         "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_CLI_VERSION}/duckdb_cli-linux-${arch}.zip" \
    && echo "${sha}  /tmp/duckdb.zip" | sha256sum -c - \
    && mkdir -p /opt/duckdb \
    && unzip -o /tmp/duckdb.zip -d /opt/duckdb \
    && chmod 0755 /opt/duckdb/duckdb \
    && rm /tmp/duckdb.zip

# pnpm is the single source of truth (CI is pnpm-native); enable via corepack
# and pin to the v10 line so the scanned/installed tree matches what ships.
RUN corepack enable && corepack prepare pnpm@latest-10 --activate

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN --mount=type=cache,id=tellus-pnpm-store,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm config set fetch-retries 5 \
    && pnpm install --frozen-lockfile --ignore-scripts

COPY src/ src/
COPY scripts/ scripts/
# Root-level JSON schemas loaded at runtime via readFileSync (e.g. the
# workshop module validator resolves ../schemas/workshop-module-v4.json from
# dist/services/workshop → /app/schemas). tsc/copy-assets only handle src/**,
# so schemas must be copied explicitly in BOTH stages.
COPY schemas/ schemas/
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
# Runtime JSON schemas (e.g. workshop-module-v4.json for the module validator).
COPY --from=builder /app/schemas/ schemas/
# DuckDB CLI for the out-of-process merge (default DUCKDB_CLI_PATH=duckdb on
# PATH). Fail the build if it cannot execute in this runtime (libc/libstdc++).
COPY --from=builder /opt/duckdb/duckdb /usr/local/bin/duckdb
RUN /usr/local/bin/duckdb --version

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
