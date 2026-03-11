# ---------------------------------------------------------------------------
# Multi-stage Dockerfile for Ontology Engine
# ---------------------------------------------------------------------------

# Stage 1 — Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

COPY src/ src/
RUN npx tsc

# Stage 2 — Production
FROM node:20-alpine

WORKDIR /app

# Run as non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist/ dist/

# Create data directory for datasource files
RUN mkdir -p /app/data && chown appuser:appgroup /app/data

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV DATA_DIR=/app/data

CMD ["node", "dist/server.js"]
