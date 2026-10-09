// ---------------------------------------------------------------------------
// Indexing stage — batched Kafka hand-off.
//
// The indexing activity used to await one Kafka produce round trip per merged
// doc (~4.7k docs/s against a local broker). It now hands docs over in batched
// produce requests. These cases pin:
//   * docs are batched up to publishBatchSize and flushed at reader-batch
//     boundaries (edit ids / kafkaOffsetHigh never run ahead of the docs);
//   * a byte cap splits batches of wide docs well under message.max.bytes;
//   * lastKafkaOffset is the max offset any batch returned;
//   * a test-injected per-doc publisher still sees every doc, in order;
//   * publishMergedDocs returns the exact LAST offset per partition
//     (baseOffset + messagesInPartition - 1), using the partitioner's real
//     placement of each message.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ topic: string; messages: Array<{ key: string; value: string }> }> = [];
let partitionCount = 3;
let nextBase: Record<number, number> = {};

vi.mock("kafkajs", async (importOriginal) => {
  const ns = await importOriginal<Record<string, unknown>>();
  // kafkajs is CommonJS: the named exports live on the default export.
  const real = { ...((ns.default as Record<string, unknown>) ?? {}), ...ns };
  class FakeKafka {
    producer(opts: { createPartitioner?: () => (a: unknown) => number }) {
      const partitioner = opts.createPartitioner!();
      return {
        connect: async () => {},
        disconnect: async () => {},
        send: async ({ topic, messages }: { topic: string; messages: Array<{ key: string; value: string }> }) => {
          sent.push({ topic, messages });
          const partitionMetadata = Array.from({ length: partitionCount }, (_, i) => ({
            partitionId: i,
            leader: 0,
          }));
          const counts = new Map<number, number>();
          for (const message of messages) {
            const p = partitioner({ topic, partitionMetadata, message });
            counts.set(p, (counts.get(p) ?? 0) + 1);
          }
          return [...counts.entries()].map(([partition, n]) => {
            const base = nextBase[partition] ?? 0;
            nextBase[partition] = base + n;
            return { topicName: topic, partition, errorCode: 0, baseOffset: String(base) };
          });
        },
      };
    }
  }
  const mocked = { ...real, Kafka: FakeKafka };
  return { ...mocked, default: mocked };
});

import { runIndexingActivity, PUBLISH_BATCH_MAX_BYTES } from "../../../src/services/quickwit/indexingActivity";
import {
  publishMergedDocs,
  __resetMergedProducerForTesting,
} from "../../../src/services/quickwit/mergedKafkaProducer";
import { QuickwitClient, resetQuickwitClientForTesting } from "../../../src/services/quickwit/client";

function publishedClient(): QuickwitClient {
  return new QuickwitClient({
    baseUrl: "http://qw",
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          splits: [
            {
              split_id: "s1",
              index_id: "ot_orders",
              num_docs: 1,
              uncompressed_docs_size_bytes: 1,
              split_state: "Published",
              publish_timestamp: Number.MAX_SAFE_INTEGER,
            },
          ],
        }),
        { status: 200 },
      )) as never,
  });
}

const row = (i: number, extra: Record<string, unknown> = {}) => ({
  primary_key: `O-${String(i).padStart(4, "0")}`,
  properties: { n: i, ...extra },
  operation: "INSERT",
  version: 1,
});

describe("indexing activity — batched publish", () => {
  beforeEach(() => {
    resetQuickwitClientForTesting();
  });

  it("batches up to publishBatchSize and flushes at reader-batch boundaries", async () => {
    const calls: string[][] = [];
    let offset = 0;
    const result = await runIndexingActivity({
      ontologyId: "o",
      objectTypeApiName: "Orders",
      primaryKeyApiName: "id",
      reader: async function* () {
        yield { rows: Array.from({ length: 7 }, (_, i) => row(i)), editIds: [] };
        yield { rows: Array.from({ length: 2 }, (_, i) => row(7 + i)), editIds: [] };
      } as never,
      publishDocs: async (_t, docs) => {
        calls.push(docs.map((d) => d.key));
        offset += docs.length;
        return offset - 1;
      },
      publishBatchSize: 3,
      client: publishedClient(),
      publishPollMs: 1,
      publishTimeoutMs: 500,
    });
    expect(calls.map((c) => c.length)).toEqual([3, 3, 1, 2]);
    expect(calls.flat()).toEqual(Array.from({ length: 9 }, (_, i) => row(i).primary_key));
    expect(result.rowsStreamed).toBe(9);
    expect(result.lastKafkaOffset).toBe(8);
  });

  it("splits wide docs by the byte cap", async () => {
    const sizes: number[] = [];
    const wide = "x".repeat(Math.ceil(PUBLISH_BATCH_MAX_BYTES / 2 / 3)); // ~1/3 of the cap each
    await runIndexingActivity({
      ontologyId: "o",
      objectTypeApiName: "Orders",
      primaryKeyApiName: "id",
      reader: async function* () {
        yield { rows: Array.from({ length: 7 }, (_, i) => row(i, { wide })), editIds: [] };
      } as never,
      publishDocs: async (_t, docs) => {
        sizes.push(docs.length);
        return 1;
      },
      publishBatchSize: 1000,
      client: publishedClient(),
      publishPollMs: 1,
      publishTimeoutMs: 500,
    });
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(7);
    expect(Math.max(...sizes)).toBeLessThan(7);
    expect(Math.max(...sizes)).toBeGreaterThan(1);
  });

  it("keeps the legacy per-doc publisher shape when only publishDoc is injected", async () => {
    const keys: string[] = [];
    const result = await runIndexingActivity({
      ontologyId: "o",
      objectTypeApiName: "Orders",
      primaryKeyApiName: "id",
      reader: async function* () {
        yield { rows: Array.from({ length: 5 }, (_, i) => row(i)), editIds: [] };
      } as never,
      publishDoc: async (_t, key) => {
        keys.push(key);
        return keys.length * 10;
      },
      client: publishedClient(),
      publishPollMs: 1,
      publishTimeoutMs: 500,
    });
    expect(keys).toEqual(Array.from({ length: 5 }, (_, i) => row(i).primary_key));
    expect(result.lastKafkaOffset).toBe(50);
  });
});

describe("publishMergedDocs — exact last offset per partition", () => {
  beforeEach(() => {
    sent.length = 0;
    nextBase = {};
    partitionCount = 3;
    __resetMergedProducerForTesting();
  });

  it("returns max(baseOffset + messagesInPartition - 1) over partitions", async () => {
    const docs = Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, doc: { __pk: `k${i}` } }));
    const first = await publishMergedDocs("merged.t", docs);
    // Every partition starts at 0, so the last offset is (largest partition count) - 1.
    const expected1 = Math.max(...Object.values(nextBase)) - 1;
    expect(first).toBe(expected1);
    expect(sent).toHaveLength(1);
    expect(sent[0].messages).toHaveLength(50);

    const second = await publishMergedDocs("merged.t", docs);
    expect(second).toBe(Math.max(...Object.values(nextBase)) - 1);
    expect(second).toBeGreaterThan(first);
  });

  it("single partition: last offset = baseOffset + n - 1", async () => {
    partitionCount = 1;
    expect(await publishMergedDocs("merged.one", [{ key: "a", doc: {} }, { key: "b", doc: {} }])).toBe(1);
    expect(await publishMergedDocs("merged.one", [{ key: "c", doc: {} }])).toBe(2);
  });

  it("empty batch is a no-op", async () => {
    expect(await publishMergedDocs("merged.t", [])).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
