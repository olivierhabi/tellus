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
    const objs = batch.map((o) => ({ primaryKey: o.primaryKey, properties: o.properties }));
    if (_client) {
      await _client.upsertObjects({
        objectTypeRid: this.objectTypeRid,
        shard,
        objects: objs,
      });
      return;
    }
    if (this.fallbackDir) {
      await fs.mkdir(this.fallbackDir, { recursive: true });
      const file = path.join(this.fallbackDir, `shard-${shard}.jsonl`);
      const lines = objs.map((o) => JSON.stringify(o)).join("\n") + "\n";
      await fs.appendFile(file, lines, "utf8");
      return;
    }
    throw new Error("Osv2Sink: no OSS client and no fallback dir configured");
  }
}
