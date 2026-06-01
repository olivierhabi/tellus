/**
 * B9 — Funnel streaming consumer.
 * Subscribes to the CDC topic for a binding and pushes transformed rows
 * through Stage 2 -> Stage 3, committing offsets to funnel_checkpoints.
 */
import type { Pool } from "pg";
import { getKafkaClient } from "../../../lib/kafka";
import type { ObjectTypeBinding } from "../contracts/object-type-binding";
import { transformRow } from "./stage2-transform";
import type { ShardIndexer } from "./stage3-index";

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
      after?: Record<string, unknown>;
    };
    if (payload.op === "d") continue;
    const obj = transformRow(payload.after ?? {}, binding);
    await indexer.push(obj);
    if (Date.now() - lastCommitAt > 1000) {
      await indexer.flushAll();
      await checkpoints.save(binding.rid, topic, msg.partition, BigInt(msg.offset));
      lastCommitAt = Date.now();
    }
  }
  await indexer.flushAll();
}
