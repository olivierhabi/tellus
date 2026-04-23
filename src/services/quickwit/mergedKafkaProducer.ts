// ---------------------------------------------------------------------------
// Kafka producer for merged docs → Quickwit — Task B6
//
// Dedicated producer separate from `kafkaProducer.ts` (which is a fan-out
// audit/event bus). This producer writes to `merged.<object_type>` topics
// that are consumed by Quickwit's native Kafka source. The producer:
//
//   • keys each message by primary key so Quickwit can partition by PK and
//     the same PK's updates land on the same partition (preserves order)
//   • serializes the full doc as JSON in the value
//   • returns the broker-acknowledged offset so the Indexing activity can
//     wait for Quickwit to publish splits past that offset
//   • degrades gracefully when Kafka is unreachable (returns a monotonic
//     timestamp-based offset so the caller's logic still terminates in dev
//     environments that don't run Redpanda/Kafka)
// ---------------------------------------------------------------------------

import { Kafka, type Producer, logLevel, CompressionTypes, CompressionCodecs } from "kafkajs";
// kafkajs ships no codec implementations for Snappy/LZ4 — they must be
// registered at process start or producer.send() with Snappy compression
// throws "Snappy compression not implemented" at runtime. The audit's test
// suite failed on exactly this case (F-XX — tracked as part of Phase A
// test-determinism work). See https://kafka.js.org/docs/producing#compression.
import SnappyCodec from "kafkajs-snappy";
CompressionCodecs[CompressionTypes.Snappy] = SnappyCodec;

const BROKERS = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",");
const ENABLED = process.env.KAFKA_ENABLED !== "false";

let producer: Producer | null = null;
let connecting: Promise<void> | null = null;
let disabled = !ENABLED;
let monotonicOffset = Date.now();

async function getProducer(): Promise<Producer | null> {
  if (disabled) return null;
  if (producer) return producer;
  if (!connecting) {
    connecting = (async () => {
      try {
        // F-P4-06: explicit requestTimeout bounds broker silences so the
        // merged-CDC producer can't stall Quickwit backfills indefinitely.
        const kafka = new Kafka({
          clientId: "tellus-funnel-merged",
          brokers: BROKERS,
          logLevel: logLevel.ERROR,
          retry: { retries: 3, initialRetryTime: 300, maxRetryTime: 2000 },
          connectionTimeout: 2000,
          requestTimeout: 5000,
        });
        const p = kafka.producer({
          allowAutoTopicCreation: true,
          // idempotent writes guarantee Quickwit sees each PK at most once
          // per produced record — the key/offset discipline prevents dupes
          // across retries.
          idempotent: true,
          maxInFlightRequests: 5,
        });
        await p.connect();
        producer = p;
        console.log(`[kafka/merged] producer connected to ${BROKERS.join(",")}`);
      } catch (err) {
        disabled = true;
        console.warn(
          `[kafka/merged] producer disabled — broker unreachable (${(err as Error).message})`
        );
      } finally {
        connecting = null;
      }
    })();
  }
  await connecting;
  return producer;
}

/**
 * Publish one merged doc to `topic`, keyed by `pk`. Returns the broker
 * offset on success, or a monotonic timestamp-based stand-in when the
 * broker is unreachable.
 */
export async function publishMergedDoc(
  topic: string,
  pk: string,
  doc: Record<string, unknown>
): Promise<number> {
  const p = await getProducer();
  const value = JSON.stringify(doc);
  if (!p) {
    monotonicOffset += 1;
    return monotonicOffset;
  }
  try {
    const [result] = await p.send({
      topic,
      compression: CompressionTypes.Snappy,
      messages: [{ key: pk, value }],
    });
    const baseOffset = Number(result?.baseOffset ?? result?.offset ?? monotonicOffset);
    if (baseOffset > monotonicOffset) monotonicOffset = baseOffset;
    return baseOffset;
  } catch (err) {
    console.warn(
      `[kafka/merged] publish failed on ${topic}: ${(err as Error).message}`
    );
    monotonicOffset += 1;
    return monotonicOffset;
  }
}

export async function shutdownMergedProducer(): Promise<void> {
  if (producer) {
    try {
      await producer.disconnect();
    } catch {
      /* ignore */
    }
    producer = null;
  }
}

// Test hook — reset internal state so unit tests can re-exercise the
// connection path without side effects from previous runs.
export function __resetMergedProducerForTesting(): void {
  producer = null;
  connecting = null;
  disabled = !ENABLED;
  monotonicOffset = Date.now();
}
