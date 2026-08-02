/**
 * B9 — Funnel streaming consumer.
 * Subscribes to the CDC topic for a binding and pushes transformed rows
 * through Stage 2 -> Stage 3, committing offsets to funnel_checkpoints.
 */
import type { Pool } from "pg";
import { getKafkaClient } from "../../../lib/kafka";
import type { ObjectTypeBinding } from "../contracts/object-type-binding";
import { transformRow, transformTombstone } from "./stage2-transform";
import type { ShardIndexer } from "./stage3-index";
import { incCounter } from "../metrics";

/**
 * A delete event we cannot attribute to a primary key. This is a loud
 * stop (offset NOT committed) rather than a silent skip: deleting the
 * wrong thing or losing a delete both violate the tombstone invariant
 * (OSv2 parity — a delete must hide all older active versions).
 */
export class StreamingDeleteUnattributableError extends Error {
  constructor(topic: string, partition: number, offset: string) {
    super(
      `delete event on ${topic}[${partition}]@${offset} carries no usable ` +
        `primary key (need 'before' with the binding pkColumn)`,
    );
    this.name = "StreamingDeleteUnattributableError";
  }
}

export interface CheckpointStore {
  load(bindingRid: string, topic: string, partition: number): Promise<bigint | null>;
  save(bindingRid: string, topic: string, partition: number, offset: bigint): Promise<void>;
}

export class CheckpointRepo implements CheckpointStore {
  constructor(private readonly db: Pool) {}
  async load(rid: string, topic: string, partition: number): Promise<bigint | null> {
    const r = await this.db.query<{ committed_offset: string }>(
      `SELECT committed_offset FROM funnel_checkpoints
        WHERE binding_rid = $1 AND topic = $2 AND partition = $3`,
      [rid, topic, partition],
    );
    return r.rows[0] ? BigInt(r.rows[0].committed_offset) : null;
  }
  async save(rid: string, topic: string, partition: number, offset: bigint): Promise<void> {
    await this.db.query(
      `INSERT INTO funnel_checkpoints(binding_rid, topic, partition, committed_offset)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (binding_rid, topic, partition)
       DO UPDATE SET committed_offset = EXCLUDED.committed_offset, last_write_ts = now()`,
      [rid, topic, partition, offset.toString()],
    );
  }
}

export async function runStreaming(
  binding: ObjectTypeBinding,
  topic: string,
  indexer: ShardIndexer,
  checkpoints: CheckpointStore,
  signal: AbortSignal,
): Promise<void> {
  const kafka = getKafkaClient();
  const consumer = await kafka.consume({
    topic,
    groupId: `funnel-${binding.rid}`,
    fromBeginning: false,
  });
  let lastCommitAt = Date.now();
  for await (const msg of consumer) {
    if (signal.aborted) break;
    const payload = JSON.parse(msg.value.toString("utf8")) as {
      op?: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    };
    if (payload.op === "d") {
      // Tombstones (OSv2 parity): a streaming delete MUST produce a
      // versioned tombstone, never a silent skip. Skipping would strand a
      // deleted object as queryable forever (the previous behaviour).
      const pk = payload.before?.[binding.pkColumn];
      if (pk === undefined || pk === null) {
        incCounter("funnel_streaming_delete_unattributable_total", {
          object_type: binding.objectTypeRid,
        });
        throw new StreamingDeleteUnattributableError(topic, msg.partition, msg.offset);
      }
      await indexer.push(transformTombstone(String(pk), binding));
      incCounter("funnel_streaming_tombstones_total", {
        object_type: binding.objectTypeRid,
      });
    } else {
      const obj = transformRow(payload.after ?? {}, binding);
      await indexer.push(obj);
    }
    if (Date.now() - lastCommitAt > 1000) {
      await indexer.flushAll();
      await checkpoints.save(binding.rid, topic, msg.partition, BigInt(msg.offset));
      lastCommitAt = Date.now();
    }
  }
  await indexer.flushAll();
}
