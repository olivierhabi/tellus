// ---------------------------------------------------------------------------
// B7 — Changelog writer (spec §B7 line 351).
//
// Wraps the KafkaAdapter. Knows the canonical topic name pattern
// `tellus.cdc.<importShort>` and the partition strategy (PK-hash, 12
// partitions default). Buffers batches of up-to-1000 messages or up-to-1s
// (whichever first) before flushing.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { loadKafkaAdapter, type KafkaAdapter, type KafkaMessage } from "../../../lib/kafka";

const FLUSH_EVERY_N = 1000;
const FLUSH_EVERY_MS = 1000;

export interface ChangelogEvent {
  /** Source schema.table. */
  source: { schema: string; table: string };
  /** 'c' insert | 'u' update | 'd' delete | 'b' begin | 'e' end. */
  op: "c" | "u" | "d" | "b" | "e";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** Source primary key as a JS object (used for PK-hash partitioning). */
  pk?: Record<string, unknown>;
  /** Source LSN. */
  lsn?: string;
  /** Source commit timestamp (ms). */
  tsMs: number;
  /** Transaction id from source. */
  txid?: number;
}

export class ChangelogWriter {
  private topic: string;
  private partitions: number;
  private kafka: KafkaAdapter | null = null;
  private buffer: KafkaMessage[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private importShort: string;
  private flushPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(importRid: string, partitions = 12, topic?: string) {
    this.importShort = importRid.split(".").pop()!.slice(0, 12);
    this.topic = topic ?? `tellus.cdc.${this.importShort}`;
    this.partitions = partitions;
  }

  async start(): Promise<void> {
    this.kafka = await loadKafkaAdapter();
    await this.kafka.ensureTopic(this.topic, this.partitions);
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_EVERY_MS);
    this.flushTimer.unref?.();
  }

  async append(ev: ChangelogEvent): Promise<void> {
    if (this.stopping) return;
    const key = ev.pk ? JSON.stringify(ev.pk) : `${ev.source.schema}.${ev.source.table}`;
    this.buffer.push({
      topic: this.topic,
      key,
      value: JSON.stringify({
        source: ev.source,
        op: ev.op,
        before: ev.before,
        after: ev.after,
        lsn: ev.lsn,
        tsMs: ev.tsMs,
        txid: ev.txid,
      }),
      partition: this.partitionFor(key),
      headers: { "tellus.op": ev.op },
      timestamp: String(ev.tsMs),
    });
    if (this.buffer.length >= FLUSH_EVERY_N) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.kafka || this.buffer.length === 0 || this.stopping) return;
    // Track in-flight flush to prevent race with stop()
    const currentFlush = this.doFlush();
    this.flushPromise = currentFlush;
    await currentFlush;
    if (this.flushPromise === currentFlush) {
      this.flushPromise = null;
    }
  }

  private async doFlush(): Promise<void> {
    if (!this.kafka || this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    await this.kafka.produce(batch);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    // Wait for any in-flight flush to complete before proceeding
    if (this.flushPromise) {
      await this.flushPromise.catch(() => undefined);
    }
    await this.flush();
    if (this.kafka) await this.kafka.close();
    this.kafka = null;
  }

  private partitionFor(key: string): number {
    const h = createHash("sha256").update(key).digest();
    // Take the first 4 bytes as uint32 -> modulo partitions.
    const n = h.readUInt32BE(0);
    return n % this.partitions;
  }
}
