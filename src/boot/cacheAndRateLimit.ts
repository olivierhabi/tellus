// ---------------------------------------------------------------------------
// src/boot/cacheAndRateLimit.ts
//
// Block D.1 + D.7 wiring. One function, one responsibility: stand up the
// two cross-replica subsystems (Redis-backed rate limiter, Kafka-backed
// cache-invalidation bus) on server boot and register shutdown hooks.
//
// Invoked once from src/server.ts during startup AFTER the Keycloak
// health check passes but BEFORE the HTTP listener opens so the rate
// limiter is armed before the first request arrives.
//
// Fail-soft semantics: both subsystems are defence-in-depth. If Redis or
// Kafka is unreachable at boot:
//
//   - Rate limiter: RATE_LIMIT_BACKEND defaults to "memory" — the legacy
//     in-memory path runs. The operator sees
//     `tellus_rate_limit_backend_selected_total{backend="memory"}` and
//     can cut over by setting the env var to "redis" once the Redis
//     client is healthy.
//   - Cache invalidation: publishInvalidation is a no-op when the bus is
//     uninitialized. Peer-replica propagation is lost; local evictions
//     still happen. The operator alerts on
//     `tellus_cache_invalidation_publish_failed_total`.
//
// Boot must not throw on Redis/Kafka errors — the app continues in
// degraded mode. Fail-closed would cascade a Redis outage into a full
// outage, which is the opposite of what F-P4-11 (circuit breakers) asks.
// ---------------------------------------------------------------------------

import type { RedisClientType } from "redis";
import type { Kafka } from "kafkajs";
import { initRedisRateLimiters } from "../middleware/rateLimiter";
import { initCacheInvalidationBus, shutdownCacheInvalidationBus } from "../services/cacheInvalidation";
import { incCounter } from "../services/funnel/metrics";

let bootedRedis: RedisClientType | null = null;
let bootedKafka: Kafka | null = null;

async function connectRedis(): Promise<RedisClientType | null> {
  if (process.env.RATE_LIMIT_BACKEND !== "redis") return null;
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn("[boot] RATE_LIMIT_BACKEND=redis but REDIS_URL unset — falling back to memory limiter");
    incCounter("tellus_rate_limit_backend_selected_total", { backend: "memory_fallback" });
    return null;
  }
  try {
    const mod = await import("redis");
    const client = mod.createClient({
      url,
      password: process.env.REDIS_PASSWORD || undefined,
      socket: {
        connectTimeout: 5_000,
        reconnectStrategy: (attempts: number) => Math.min(attempts * 500, 30_000),
      },
    }) as RedisClientType;
    client.on("error", (err: Error) => {
      console.warn(`[boot] redis client error: ${err.message}`);
    });
    await client.connect();
    return client;
  } catch (err) {
    console.warn(
      `[boot] redis connect failed — falling back to memory limiter: ${
        err instanceof Error ? err.message : err
      }`,
    );
    incCounter("tellus_rate_limit_backend_selected_total", { backend: "memory_fallback" });
    return null;
  }
}

async function connectKafka(): Promise<Kafka | null> {
  const brokers = process.env.KAFKA_BOOTSTRAP_SERVERS;
  if (!brokers) {
    // Many dev bring-ups don't need Kafka — that's fine, skip silently.
    return null;
  }
  try {
    const mod = await import("kafkajs");
    const kafka = new mod.Kafka({
      clientId: `tellus-${process.env.HOSTNAME ?? "local"}`,
      brokers: brokers.split(","),
      connectionTimeout: 5_000,
      requestTimeout: 30_000,
      retry: { retries: 5, initialRetryTime: 300 },
      ssl: process.env.KAFKA_SSL_CA_CERT ? true : undefined,
      sasl:
        process.env.KAFKA_SASL_USERNAME && process.env.KAFKA_SASL_PASSWORD
          ? {
              mechanism: (process.env.KAFKA_SASL_MECHANISM as any) ?? "plain",
              username: process.env.KAFKA_SASL_USERNAME,
              password: process.env.KAFKA_SASL_PASSWORD,
            }
          : undefined,
    });
    return kafka;
  } catch (err) {
    console.warn(
      `[boot] kafka init failed — cache-invalidation bus disabled: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return null;
  }
}

/**
 * One-shot bootstrap. Called from src/server.ts during startup.
 * Idempotent — safe to call twice (second call is a no-op).
 */
export async function bootstrapK8sInfra(): Promise<void> {
  if (bootedRedis === null) {
    bootedRedis = await connectRedis();
    if (bootedRedis) {
      initRedisRateLimiters(bootedRedis);
      console.log("[boot] redis-backed rate limiter armed");
    } else if (
      process.env.NODE_ENV === "production" &&
      process.env.ALLOW_INMEMORY_RATELIMIT !== "1"
    ) {
      // Boot-time (NOT runtime) fail-closed: a per-replica in-memory limiter
      // silently grants N× the configured limit across N pods and resets on
      // every restart — unacceptable for a multi-replica production rollout.
      // We refuse to start rather than degrade silently. Single-replica
      // deployments that genuinely want the in-memory limiter must opt in
      // explicitly with ALLOW_INMEMORY_RATELIMIT=1. (Runtime Redis outages
      // still fail OPEN inside redisRateLimiter to avoid cascading a Redis
      // blip into a full outage — see that module; this guard only governs
      // the deliberate boot-time backend choice.)
      throw new Error(
        "Production start refused: no Redis-backed rate limiter is armed. " +
          "Set RATE_LIMIT_BACKEND=redis with a reachable REDIS_URL, or, for a " +
          "single-replica deployment, opt into the per-replica in-memory " +
          "limiter explicitly with ALLOW_INMEMORY_RATELIMIT=1.",
      );
    }
  }

  if (bootedKafka === null) {
    bootedKafka = await connectKafka();
    if (bootedKafka) {
      try {
        await initCacheInvalidationBus(bootedKafka);
        console.log("[boot] cache-invalidation bus subscribed");
      } catch (err) {
        console.warn(
          `[boot] cache-invalidation bus subscribe failed: ${
            err instanceof Error ? err.message : err
          }`,
        );
      }
    }
  }
}

/**
 * Graceful shutdown hook — called from the server's SIGTERM handler.
 */
export async function shutdownK8sInfra(): Promise<void> {
  await shutdownCacheInvalidationBus().catch(() => undefined);
  if (bootedRedis) {
    await bootedRedis.quit().catch(() => undefined);
    bootedRedis = null;
  }
  bootedKafka = null;
}

export default { bootstrapK8sInfra, shutdownK8sInfra };
