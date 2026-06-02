# ---------------------------------------------------------------------------
# Multi-stage Dockerfile for Ontology Engine
# ---------------------------------------------------------------------------

# Stage 1 — Build
FROM node:24-alpine AS builder

WORKDIR /app

# pnpm is the single source of truth (CI is pnpm-native); enable via corepack
# and pin to the v10 line so the scanned/installed tree matches what ships.
RUN corepack enable && corepack prepare pnpm@latest-10 --activate

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY src/ src/
RUN pnpm exec tsc

# Stage 2 — Production
FROM node:24-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest-10 --activate

# Run as non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune

COPY --from=builder /app/dist/ dist/

# Create data directory for datasource files
RUN mkdir -p /app/data && chown appuser:appgroup /app/data

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

CMD ["node", "dist/server.js"]
