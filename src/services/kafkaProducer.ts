/**
 * Kafka event producer for ontology mutations.
 *
 * Publishes every action / edit / audit event so downstream consumers
 * (Apache Flink for the Object Data Funnel pipeline, the audit log
 * indexer, observers in the UI) can subscribe without touching Postgres.
 *
 * The producer is lazy: it only opens a connection when the first
 * `publishEvent()` call comes in, so dev environments without Redpanda
 * still boot. If the broker is unreachable we log and swallow — events
 * are best-effort.
 *
 * Topics produced:
 *   • ontology.events  — all mutations (catch-all)
 *   • ontology.actions — POST /actions/:apiName/apply
 *   • ontology.edits   — schema edits (createObjectType, addProperty, …)
 *   • ontology.audit   — audit log rows
 */

import { Kafka, type Producer, logLevel } from 'kafkajs';

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const ENABLED = process.env.KAFKA_ENABLED !== 'false';

let producer: Producer | null = null;
let connecting: Promise<void> | null = null;
let disabled = !ENABLED;

async function getProducer(): Promise<Producer | null> {
  if (disabled) return null;
  if (producer) return producer;
  if (!connecting) {
    connecting = (async () => {
      try {
        const kafka = new Kafka({
          clientId: 'tellus-ontology',
          brokers: BROKERS,
          logLevel: logLevel.ERROR,
          retry: { retries: 2, initialRetryTime: 200 },
          connectionTimeout: 1500,
        });
        const p = kafka.producer({ allowAutoTopicCreation: true });
        await p.connect();
        producer = p;
        // eslint-disable-next-line no-console
        console.log(`[kafka] producer connected to ${BROKERS.join(',')}`);
      } catch (err) {
        disabled = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[kafka] producer disabled — broker unreachable (${(err as Error).message})`,
        );
      } finally {
        connecting = null;
      }
    })();
  }
  await connecting;
  return producer;
}

export type OntologyEventTopic =
  | 'ontology.events'
  | 'ontology.actions'
  | 'ontology.edits'
  | 'ontology.audit';

/** Publish an event to one or more topics. Always best-effort. */
export async function publishEvent(
  topic: OntologyEventTopic,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const p = await getProducer();
    if (!p) return;
    await p.send({
      topic,
      messages: [
        {
          key: String(payload.ontologyId ?? payload.objectType ?? 'na'),
          value: JSON.stringify({
            ...payload,
            emittedAt: new Date().toISOString(),
          }),
        },
      ],
    });
    // Also fan out to the catch-all topic so a single consumer can see
    // everything without subscribing per type.
    if (topic !== 'ontology.events') {
      await p.send({
        topic: 'ontology.events',
        messages: [
          {
            key: String(payload.ontologyId ?? 'na'),
            value: JSON.stringify({
              source: topic,
              ...payload,
              emittedAt: new Date().toISOString(),
            }),
          },
        ],
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[kafka] publish failed: ${(err as Error).message}`);
  }
}

/** Cleanly shut the producer down on process exit. */
export async function shutdownKafka(): Promise<void> {
  if (producer) {
    try {
      await producer.disconnect();
    } catch {
      /* ignore */
    }
    producer = null;
  }
}
