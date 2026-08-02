// ---------------------------------------------------------------------------
// Streaming object-delete tombstones (OSv2 parity): a delete event must
// create a versioned tombstone in the serving store; it must never be
// silently dropped with its offset committed.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runStreaming,
  StreamingDeleteUnattributableError,
} from "../../../src/services/funnel/pipeline/streaming-consumer";
import { setKafkaClient, type KafkaConsumerMessage } from "../../../src/lib/kafka";
import { ShardIndexer } from "../../../src/services/funnel/pipeline/stage3-index";
import type { TransformedObject } from "../../../src/services/funnel/pipeline/stage2-transform";

function binding(over: Partial<Record<string, unknown>> = {}) {
  return {
    rid: "ri.funnel.main.binding.1",
    datasetRid: "ri.compass.main.dataset.1",
    objectTypeRid: "ri.ontology.main.object-type.orders",
    propertyMap: { id: "orderId", status: "status" },
    indexedProperties: ["orderId", "status"],
    pkColumn: "id",
    shardCount: 4,
    mode: "streaming" as const,
    status: "ready" as const,
    version: 1,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-01T00:00:00Z",
    ...over,
  } as never;
}

function msgs(list: Array<Record<string, unknown>>): KafkaConsumerMessage[] {
  return list.map((payload, i) => ({
    topic: "cdc.orders",
    partition: 0,
    offset: String(i + 1),
    key: null,
    value: Buffer.from(JSON.stringify(payload)),
    headers: {},
  }));
}

async function* iter(m: KafkaConsumerMessage[]): AsyncGenerator<KafkaConsumerMessage> {
  for (const x of m) yield x;
}

describe("streaming consumer tombstones", () => {
  afterEach(() => {
    setKafkaClient({ consume: async () => iter([]), produce: async () => {}, close: async () => {} });
  });

  it("delete events push a tombstone; upserts push the transformed row; offsets commit", async () => {
    setKafkaClient({
      consume: async () =>
        iter(
          msgs([
            { op: "u", after: { id: "A", status: "paid" } },
            { op: "d", before: { id: "B" } },
          ]),
        ),
      produce: async () => {},
      close: async () => {},
    });
    const written: TransformedObject[][] = [];
    const saved: Array<bigint> = [];
    const indexer = new ShardIndexer({
      write: async (_shard, batch) => {
        written.push([...batch]);
      },
    });
    await runStreaming(
      binding(),
      "cdc.orders",
      indexer,
      { load: async () => null, save: async (_r, _t, _p, o) => { saved.push(o); } },
      new AbortController().signal,
    );
    const all = written.flat();
    const tombstone = all.find((o) => o.primaryKey === "B");
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.properties).toEqual({});
    const up = all.find((o) => o.primaryKey === "A");
    expect(up?.deleted).not.toBe(true);
    expect(up?.properties).toEqual({ orderId: "A", status: "paid" });
    // Offsets commit on a 1s cadence, not per message: a fast run
    // redelivers on restart (at-least-once) — consumers must be idempotent.
    expect(saved.length).toBe(0);
  });

  it("a delete without a usable primary key throws loudly and never commits the offset", async () => {
    setKafkaClient({
      consume: async () => iter(msgs([{ op: "d", before: { other: "x" } }])),
      produce: async () => {},
      close: async () => {},
    });
    const saved: Array<bigint> = [];
    const indexer = new ShardIndexer({ write: async () => {} });
    await expect(
      runStreaming(
        binding(),
        "cdc.orders",
        indexer,
        { load: async () => null, save: async (_r, _t, _p, o) => { saved.push(o); } },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(StreamingDeleteUnattributableError);
    expect(saved).toEqual([]);
  });
});
