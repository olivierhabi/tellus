/**
 * B9 — OSv2 index sink.
 * Calls the OSS write path to upsert objects into the object-storage v2 index.
 * Falls back to a JSONL sidecar file when the OSS client is unavailable
 * (development / Testcontainers without the OSS service).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IndexSink } from "./stage3-index";
import type { TransformedObject } from "./stage2-transform";

export interface OssWriteClient {
  upsertObjects(args: {
    objectTypeRid: string;
    shard: number;
    objects: Array<{ primaryKey: string; properties: Record<string, unknown> }>;
  }): Promise<void>;
  /**
   * Apply versioned tombstones for deleted objects. Implementations must
   * guarantee that a tombstone hides all older active versions of the PK.
   * If omitted, the sink fails loudly on tombstones instead of dropping
   * them (deleted data must never silently stay visible).
   */
  deleteObjects?(args: { objectTypeRid: string; shard: number; primaryKeys: string[] }): Promise<void>;
}

let _client: OssWriteClient | null = null;
export function setOssClient(c: OssWriteClient | null) {
  _client = c;
}

export class Osv2Sink implements IndexSink {
  constructor(
    private readonly objectTypeRid: string,
    private readonly fallbackDir?: string,
  ) {}
  async write(shard: number, batch: TransformedObject[]): Promise<void> {
    const upserts = batch.filter((o) => !o.deleted);
    const tombstones = batch.filter((o) => o.deleted);
    const objs = upserts.map((o) => ({ primaryKey: o.primaryKey, properties: o.properties }));
    if (_client) {
      if (objs.length > 0) {
        await _client.upsertObjects({
          objectTypeRid: this.objectTypeRid,
          shard,
          objects: objs,
        });
      }
      if (tombstones.length > 0) {
        if (!_client.deleteObjects) {
          // Fail closed: never silently drop a delete.
          throw new Error(
            `Osv2Sink: ${tombstones.length} tombstone(s) for ${this.objectTypeRid} but the OSS client has no deleteObjects`,
          );
        }
        await _client.deleteObjects({
          objectTypeRid: this.objectTypeRid,
          shard,
          primaryKeys: tombstones.map((o) => o.primaryKey),
        });
      }
      return;
    }
    if (this.fallbackDir) {
      await fs.mkdir(this.fallbackDir, { recursive: true });
      const file = path.join(this.fallbackDir, `shard-${shard}.jsonl`);
      const lines = [
        ...objs.map((o) => JSON.stringify(o)),
        // Tombstones are persisted in the sidecar too so replay/rebuild
        // converge to the same active state as the live stream.
        ...tombstones.map((o) => JSON.stringify({ primaryKey: o.primaryKey, __deleted: true })),
      ].join("\n");
      if (lines.length > 0) await fs.appendFile(file, lines + "\n", "utf8");
      return;
    }
    throw new Error("Osv2Sink: no OSS client and no fallback dir configured");
  }
}
