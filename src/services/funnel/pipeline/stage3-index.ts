/**
 * B9 — Funnel Stage 3: Index.
 * Batches transformed objects per shard and forwards to the OSv2 index sink.
 * Maintains per-shard backpressure: 2 MiB/s streaming cap from the spec.
 */
import type { TransformedObject } from "./stage2-transform";

export interface IndexSink {
  write(shard: number, batch: TransformedObject[]): Promise<void>;
}

const MAX_BATCH_OBJECTS = 1000;
const MAX_BATCH_BYTES = 4 * 1024 * 1024; // 4 MiB
const STREAM_BYTES_PER_SEC = 2 * 1024 * 1024; // 2 MiB/s per spec

export class ShardIndexer {
  private buffers = new Map<number, TransformedObject[]>();
  private bufferBytes = new Map<number, number>();
  private lastFlushAt = new Map<number, number>();

  constructor(private readonly sink: IndexSink) {}

  async push(obj: TransformedObject): Promise<void> {
    const buf = this.buffers.get(obj.shard) ?? [];
    const bytes = (this.bufferBytes.get(obj.shard) ?? 0) + obj.sizeBytes;
    buf.push(obj);
    this.buffers.set(obj.shard, buf);
    this.bufferBytes.set(obj.shard, bytes);
    if (buf.length >= MAX_BATCH_OBJECTS || bytes >= MAX_BATCH_BYTES) {
      await this.flushShard(obj.shard);
    }
  }

  async flushShard(shard: number): Promise<void> {
    const buf = this.buffers.get(shard);
    if (!buf || buf.length === 0) return;
    const bytes = this.bufferBytes.get(shard) ?? 0;
    // Streaming throttle.
    const last = this.lastFlushAt.get(shard) ?? 0;
    const minIntervalMs = (bytes / STREAM_BYTES_PER_SEC) * 1000;
    const elapsed = Date.now() - last;
    if (last > 0 && elapsed < minIntervalMs) {
      await new Promise((r) => setTimeout(r, minIntervalMs - elapsed));
    }
    await this.sink.write(shard, buf);
    this.lastFlushAt.set(shard, Date.now());
    this.buffers.set(shard, []);
    this.bufferBytes.set(shard, 0);
  }

  async flushAll(): Promise<void> {
    for (const shard of [...this.buffers.keys()]) await this.flushShard(shard);
  }
}
