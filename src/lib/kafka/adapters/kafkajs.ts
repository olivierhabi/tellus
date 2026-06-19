// ---------------------------------------------------------------------------
// B7 — kafkajs Kafka adapter (spec §B7 line 356).
//
// Connects to Redpanda by default (TELLUS_KAFKA_BROKERS=localhost:9092).
// If kafkajs isn't installed (unit-test profile), falls back to an in-memory
// shim that satisfies the KafkaAdapter contract and stores messages in a
// per-process array (introspectable via `_drainInMemoryFor(topic)`).
// ---------------------------------------------------------------------------

import type { KafkaAdapter, KafkaMessage } from "../index";

const inMemory = new Map<string, KafkaMessage[]>();

export function _drainInMemoryFor(topic: string): KafkaMessage[] {
  const out = inMemory.get(topic) ?? [];
  inMemory.set(topic, []);
  return out;
}

export async function createKafkaJsAdapter(): Promise<KafkaAdapter> {
  let kafkajs: any = null;
  try {
    kafkajs = await import("kafkajs");
  } catch {
    return inMemoryAdapter();
  }
  const brokers = (process.env.TELLUS_KAFKA_BROKERS ?? "127.0.0.1:9092")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const client = new kafkajs.Kafka({
    clientId: process.env.TELLUS_KAFKA_CLIENT_ID ?? "tellus-cdc",
    brokers,
  });
  const admin = client.admin();
  const producer = client.producer({ allowAutoTopicCreation: false });
  await admin.connect();
  await producer.connect();
  const knownTopics = new Set<string>();
  return {
    async ensureTopic(topic, partitions) {
      if (knownTopics.has(topic)) return;
      const existing = await admin.listTopics();
      if (!existing.includes(topic)) {
        await admin.createTopics({
          topics: [{ topic, numPartitions: partitions, replicationFactor: 1 }],
        });
      }
      knownTopics.add(topic);
    },
    async produce(messages) {
      const byTopic = new Map<string, any[]>();
      for (const m of messages) {
        const arr = byTopic.get(m.topic) ?? [];
        arr.push({
          key: m.key,
          value: m.value,
          partition: m.partition,
          headers: m.headers,
          timestamp: m.timestamp,
        });
        byTopic.set(m.topic, arr);
      }
      const batches = [...byTopic.entries()].map(([topic, msgs]) => ({
        topic,
        messages: msgs,
      }));
      for (const b of batches) {
        await producer.send(b);
      }
    },
    async close() {
      await producer.disconnect();
      await admin.disconnect();
    },
  };
}

function inMemoryAdapter(): KafkaAdapter {
  return {
    async ensureTopic(topic) {
      if (!inMemory.has(topic)) inMemory.set(topic, []);
    },
    async produce(messages) {
      for (const m of messages) {
        const arr = inMemory.get(m.topic) ?? [];
        arr.push(m);
        inMemory.set(m.topic, arr);
      }
    },
    async close() {
      /* nothing */
    },
  };
}
