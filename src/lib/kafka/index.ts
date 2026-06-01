// ---------------------------------------------------------------------------
// B7 — KafkaAdapter (spec §B7 line 355).
//
// Pluggable interface; default = kafkajs (line 356). Stubs for confluent /
// pulsar to come later.
// ---------------------------------------------------------------------------

export interface KafkaMessage {
  topic: string;
  key?: string;
  value: Buffer | string;
  partition?: number;
  headers?: Record<string, string>;
  timestamp?: string;
}

export interface KafkaAdapter {
  ensureTopic(topic: string, partitions: number): Promise<void>;
  produce(messages: KafkaMessage[]): Promise<void>;
  close(): Promise<void>;
}

export async function loadKafkaAdapter(): Promise<KafkaAdapter> {
  const which = process.env.TELLUS_KAFKA_ADAPTER ?? "kafkajs";
  switch (which) {
    case "kafkajs": {
      const mod = await import("./adapters/kafkajs");
      return mod.createKafkaJsAdapter();
    }
    default:
      throw new Error(`Unknown TELLUS_KAFKA_ADAPTER: ${which}`);
  }
}

// ---------------------------------------------------------------------------
// Consumer surface used by B9 Funnel streaming-consumer.
// `getKafkaClient()` returns a minimal client whose `consume()` produces an
// async iterable of consumer messages. Real implementations replace via
// `setKafkaClient()` at process boot.
// ---------------------------------------------------------------------------

export interface KafkaConsumerMessage {
  topic: string;
  partition: number;
  offset: string;
  key: Buffer | null;
  value: Buffer;
  headers: Record<string, Buffer | string>;
}

export interface KafkaClient {
  consume(opts: {
    topic: string;
    groupId: string;
    fromBeginning?: boolean;
  }): Promise<AsyncIterable<KafkaConsumerMessage>>;
  produce(messages: KafkaMessage[]): Promise<void>;
  close(): Promise<void>;
}

let client: KafkaClient | null = null;

export function setKafkaClient(c: KafkaClient): void {
  client = c;
}

function defaultKafkaClient(): KafkaClient {
  return {
    async consume() {
      async function* empty(): AsyncGenerator<KafkaConsumerMessage> {
        // intentionally empty
      }
      return empty();
    },
    async produce() {
      // no-op
    },
    async close() {
      // no-op
    },
  };
}

export function getKafkaClient(): KafkaClient {
  return client ?? defaultKafkaClient();
}

