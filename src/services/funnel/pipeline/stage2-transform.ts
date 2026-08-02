/**
 * B9 — Funnel Stage 2: Transform.
 * Applies propertyMap (source column -> object property), enforces required PK,
 * coerces types per OSv2 capacity contract (250 properties, 1 MiB per object).
 */
import type { ObjectTypeBinding } from "../contracts/object-type-binding";

export type TransformedObject = {
  primaryKey: string;
  shard: number;
  properties: Record<string, unknown>;
  sizeBytes: number;
  /**
   * Versioned-delete marker (OSv2 parity): a delete event MUST NOT be
   * dropped; it is carried through the pipeline as a tombstone so the
   * serving store converges to "absent" rather than keeping a stale
   * active row. Sinks that cannot represent tombstones must fail loudly.
   */
  deleted?: boolean;
};

const MAX_PROPERTIES = 250;
const MAX_OBJECT_BYTES = 1024 * 1024; // 1 MiB

export class FunnelTransformError extends Error {
  constructor(
    public readonly code: "MissingPrimaryKey" | "TooManyProperties" | "ObjectTooLarge",
    message: string,
  ) {
    super(message);
  }
}

export function hashShard(pk: string, shards: number): number {
  // Simple FNV-1a 32-bit; deterministic across nodes.
  let h = 0x811c9dc5;
  for (let i = 0; i < pk.length; i++) {
    h ^= pk.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % shards;
}

export function transformRow(
  row: Record<string, unknown>,
  binding: ObjectTypeBinding,
): TransformedObject {
  const props: Record<string, unknown> = {};
  for (const [src, dst] of Object.entries(binding.propertyMap)) {
    const v = row[src as string];
    if (v !== undefined) props[dst as string] = v;
  }
  if (Object.keys(props).length > MAX_PROPERTIES) {
    throw new FunnelTransformError(
      "TooManyProperties",
      `object exceeds ${MAX_PROPERTIES} properties`,
    );
  }
  const pkSrc = binding.pkColumn;
  const pkVal = row[pkSrc];
  if (pkVal === undefined || pkVal === null) {
    throw new FunnelTransformError("MissingPrimaryKey", `pk column ${pkSrc} is null`);
  }
  const pk = String(pkVal);
  const serialised = JSON.stringify(props);
  const sizeBytes = Buffer.byteLength(serialised, "utf8");
  if (sizeBytes > MAX_OBJECT_BYTES) {
    throw new FunnelTransformError(
      "ObjectTooLarge",
      `object ${pk} is ${sizeBytes}B, exceeds 1 MiB`,
    );
  }
  return {
    primaryKey: pk,
    shard: hashShard(pk, binding.shardCount ?? 16),
    properties: props,
    sizeBytes,
  };
}

/**
 * Build a tombstone for a deleted object. Only the primary key is
 * authoritative — user properties are dropped (they no longer exist) so
 * the tombstone stays small and cannot leak deleted content.
 */
export function transformTombstone(
  primaryKey: string,
  binding: ObjectTypeBinding,
): TransformedObject {
  const pk = String(primaryKey);
  return {
    primaryKey: pk,
    shard: hashShard(pk, binding.shardCount ?? 16),
    properties: {},
    sizeBytes: Buffer.byteLength(pk, "utf8"),
    deleted: true,
  };
}
