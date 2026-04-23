// ---------------------------------------------------------------------------
// src/services/cacheInvalidation.ts
//
// Closes F-P5-09 — no cross-replica cache invalidation. Under K8s with
// N replicas, invalidateCache(...) on replica A leaves replicas B and C
// serving stale metadata until their TTL expires.
//
// This module publishes invalidation messages to a Kafka topic
// (`tellus.cache.invalidations`) and exposes a subscribe() helper that
// each replica invokes on boot to register per-cache handlers. When a
// message arrives, every replica (including the publisher) invokes the
// handler — the publisher already ran the local invalidation before
// publishing so the extra self-dispatch is a no-op.
//
// Message shape:
//   {
//     cache: "propertyResolver" | "breadcrumbService" | "systemSettings"
//          | "indexName" | "actionTypeCbac",
//     keys: string[],           // specific keys to evict, or
//     purgeAll: boolean,        // nuke the entire cache
//     ontologyId?: string,      // tenant scope (F-P5-03 compliance)
//     publisher: string,        // replica identifier (pod name)
//     issuedAt: number,         // unix ms
//     correlationId: string
//   }
//
// At-least-once delivery. Handlers MUST be idempotent — evicting an
// already-evicted key is a no-op. The Kafka topic is configured with
// cleanup.policy=delete and retention.ms=600000 (10 min) so the buffer
// size is bounded.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import type { Kafka, Consumer, Producer } from "kafkajs";
import { incCounter } from "./funnel/metrics";

export type CacheName =
  | "propertyResolver"
  | "breadcrumbService"
  | "systemSettings"
  | "indexName"
  | "actionTypeCbac";

export interface InvalidationMessage {
  cache: CacheName;
  keys: string[];
  purgeAll: boolean;
  ontologyId?: string;
  publisher: string;
  issuedAt: number;
  correlationId: string;
}

export type InvalidationHandler = (msg: InvalidationMessage) => Promise<void> | void;

const TOPIC = "tellus.cache.invalidations";
const handlers = new Map<CacheName, InvalidationHandler[]>();

let producer: Producer | null = null;
let consumer: Consumer | null = null;
let selfId: string = process.env.HOSTNAME ?? `local-${process.pid}`;

/**
 * Register a handler for a given cache. Called during boot from the
 * cache service's module-init code (e.g. propertyResolver calls
 * `registerInvalidationHandler("propertyResolver", handler)`).
 */
export function registerInvalidationHandler(cache: CacheName, handler: InvalidationHandler): void {
  const existing = handlers.get(cache) ?? [];
  existing.push(handler);
  handlers.set(cache, existing);
}

/**
 * Initialize the invalidation bus. Called exactly once from src/server.ts
 * after Kafka is ready. Idempotent — no-op on repeat call.
 */
export async function initCacheInvalidationBus(kafka: Kafka): Promise<void> {
  if (producer !== null) return;
  producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true });
  await producer.connect();

  consumer = kafka.consumer({ groupId: `tellus-cache-inv-${selfId}` });
  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const payload = JSON.parse(message.value!.toString("utf-8")) as InvalidationMessage;
        const cacheHandlers = handlers.get(payload.cache) ?? [];
        for (const h of cacheHandlers) {
          await h(payload);
        }
        incCounter("tellus_cache_invalidation_consumed_total", {
          cache: payload.cache,
          self: payload.publisher === selfId ? "true" : "false",
        });
      } catch (err) {
        incCounter("tellus_cache_invalidation_consume_failed_total", {
          reason: err instanceof Error ? err.constructor.name : "unknown",
        });
        console.error(
          `[cacheInvalidation] consume failure: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  });
}

/**
 * Publish an invalidation. Call AFTER the local cache has already been
 * updated — publish is best-effort propagation to peers. On Kafka
 * failure the local eviction still happened; we log a metric so
 * operators see propagation lag.
 */
export async function publishInvalidation(
  cache: CacheName,
  opts: { keys?: string[]; purgeAll?: boolean; ontologyId?: string },
): Promise<void> {
  if (producer === null) {
    // Bus not initialized (e.g. in tests). Treat as local-only.
    return;
  }
  const msg: InvalidationMessage = {
    cache,
    keys: opts.keys ?? [],
    purgeAll: Boolean(opts.purgeAll),
    ontologyId: opts.ontologyId,
    publisher: selfId,
    issuedAt: Date.now(),
    correlationId: crypto.randomBytes(8).toString("hex"),
  };
  try {
    await producer.send({
      topic: TOPIC,
      messages: [{ key: cache, value: JSON.stringify(msg) }],
    });
    incCounter("tellus_cache_invalidation_published_total", { cache });
  } catch (err) {
    incCounter("tellus_cache_invalidation_publish_failed_total", { cache });
    console.warn(
      `[cacheInvalidation] publish failure (local eviction already applied): ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

/** Clean shutdown — called from graceful shutdown path. */
export async function shutdownCacheInvalidationBus(): Promise<void> {
  if (consumer) {
    await consumer.disconnect().catch(() => undefined);
    consumer = null;
  }
  if (producer) {
    await producer.disconnect().catch(() => undefined);
    producer = null;
  }
}

/** Test hook. */
export function __resetForTests(): void {
  handlers.clear();
  producer = null;
  consumer = null;
  selfId = process.env.HOSTNAME ?? `local-${process.pid}`;
}
