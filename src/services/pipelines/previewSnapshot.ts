// ---------------------------------------------------------------------------
// Preview-snapshot helpers — PB-B6.
//
// Shared utilities for "what version of the upstream did I see?" and
// "did the transform chain change since I saved the preview?". The
// deploy path reads back these captured values to resolve pinned reads,
// reject stale previews, and record `pipeline_deployments.input_snapshots`.
//
// Semantics — intentionally minimal:
//
//   * `hashTransformChain(chain)` — deterministic SHA-256 of the JSON
//     canonicalisation of the chain. Keys sorted, nulls stripped so a
//     re-save that re-serializes the same chain produces the same
//     hash. This is what the stale-detector compares against the live
//     chain on a node.
//
//   * `fingerprintSchema(columns)` — same idea over the column list so
//     a schema drift (rename, type change) is caught even when the
//     transform chain hash hasn't moved.
//
//   * `captureInputVersion(dataset)` — at preview time, ask the source
//     of truth for its version coordinates:
//       - Iceberg → current snapshot id (via the sidecar).
//       - Parquet/CSV → S3 ETag + VersionId. If the bucket is not
//         versioning-enabled we throw INPUT_NOT_VERSIONED here so the
//         preview fails loudly rather than silently accepting an
//         unpinnable input that would diverge at deploy time.
// ---------------------------------------------------------------------------

import crypto from "crypto";
import { AppError } from "../../utils/foundryAppError";
import {
  headObjectWithVersion,
  isBucketVersioningEnabled,
} from "../storageService";
import {
  icebergSnapshots,
} from "./icebergSidecar";

export type InputFormat = "iceberg" | "parquet" | "csv";

export interface CapturedInputVersion {
  dataset_id: string | null;
  format: InputFormat;
  /** Iceberg snapshot id as string (may exceed JS safe int). */
  upstream_snapshot_id?: string | null;
  /** S3 VersionId when the bucket is versioned. */
  s3_version_id?: string | null;
  /** S3 ETag — best-effort tamper detector on non-versioned storage. */
  etag?: string | null;
  captured_at: string;
  /**
   * If the caller passed `allowUnversioned=true`, this is set to
   * 'etag-only' so downstream tooling can flag the degraded pin.
   */
  pinMode: "iceberg-snapshot" | "s3-version" | "etag-only";
}

export interface PreviewSnapshotEnvelope {
  input_snapshots: Record<string, CapturedInputVersion>;
  chain_hash: string;
  schema_fingerprint: string;
  captured_at: string;
}

/** Canonical JSON stringify: keys sorted, undefined stripped. */
export function canonicalStringify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalStringify(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

/**
 * SHA-256 of the canonical serialization. Stable across key order and
 * harmless whitespace differences; sensitive to any meaningful change
 * in the transforms array (a new Cast, a flipped filter operator, a
 * swapped Join side).
 */
export function hashTransformChain(chain: unknown): string {
  const payload = canonicalStringify(chain);
  return crypto.createHash("sha256").update(payload, "utf-8").digest("hex");
}

/**
 * SHA-256 of `[{name, type}]` in order. Column order matters (same as
 * the deploy's CSV serialization order) so a swap in ordinal_position
 * breaks the fingerprint.
 */
export function fingerprintSchema(
  columns: Array<{ name: string; type: string }>,
): string {
  const norm = columns.map((c) => ({ name: String(c.name), type: String(c.type ?? "text") }));
  return crypto
    .createHash("sha256")
    .update(canonicalStringify(norm), "utf-8")
    .digest("hex");
}

export interface CaptureOptions {
  /** Accept etag-only pinning on an unversioned bucket. Default: false. */
  allowUnversioned?: boolean;
  /** Used to resolve Iceberg snapshot id for `format='iceberg'` datasets. */
  icebergRef?: {
    warehouse?: string;
    namespace: string;
    table: string;
  };
}

/**
 * Capture the version coordinates of a dataset at preview time. For
 * Iceberg inputs we call the sidecar and stringify the latest snapshot
 * id; for S3 inputs we HEAD the object and record ETag/VersionId. An
 * unversioned bucket + `!allowUnversioned` throws INPUT_NOT_VERSIONED
 * so the preview fails at creation time instead of silently producing
 * an unpinnable envelope.
 */
export async function captureInputVersion(
  dataset: {
    id: string;
    file_path?: string | null;
    format?: string | null;
  },
  opts: CaptureOptions = {},
): Promise<CapturedInputVersion> {
  const format = normaliseFormat(dataset.format);
  if (format === "iceberg") {
    if (!opts.icebergRef) {
      throw new AppError(
        "captureInputVersion(iceberg) requires an icebergRef (namespace/table).",
        500,
        "PREVIEW_SNAPSHOT_INVALID_INPUT",
      );
    }
    const { snapshots } = await icebergSnapshots({
      namespace: opts.icebergRef.namespace,
      table: opts.icebergRef.table,
      warehouse: opts.icebergRef.warehouse,
    });
    const latest = snapshots[snapshots.length - 1];
    return {
      dataset_id: dataset.id,
      format: "iceberg",
      upstream_snapshot_id: latest ? latest.snapshot_id : null,
      captured_at: new Date().toISOString(),
      pinMode: "iceberg-snapshot",
    };
  }

  // Parquet / CSV → S3 pinning.
  if (!dataset.file_path) {
    throw new AppError(
      "Input dataset has no file_path; cannot capture a version.",
      400,
      "PREVIEW_SNAPSHOT_INVALID_INPUT",
    );
  }
  const head = await headObjectWithVersion(dataset.file_path);
  const versioning = await isBucketVersioningEnabled();
  if (!versioning && !opts.allowUnversioned) {
    const err = new AppError(
      "Pipeline preview requires S3 versioning on the input bucket. " +
        "Enable bucket versioning or opt in to etag-only pinning (degraded).",
      400,
      "INPUT_NOT_VERSIONED",
    );
    (err as unknown as { details?: unknown }).details = {
      datasetId: dataset.id,
      bucket: "<configured>",
      filePath: dataset.file_path,
    };
    throw err;
  }
  return {
    dataset_id: dataset.id,
    format,
    s3_version_id: versioning ? head.versionId ?? null : null,
    etag: head.etag,
    captured_at: new Date().toISOString(),
    pinMode: versioning && head.versionId ? "s3-version" : "etag-only",
  };
}

function normaliseFormat(raw: string | null | undefined): InputFormat {
  const f = (raw ?? "csv").toLowerCase();
  if (f === "iceberg") return "iceberg";
  if (f === "parquet") return "parquet";
  return "csv";
}

/**
 * Compute the current canonical chain hash for a node given its config
 * JSON. Kept here so transformService and deploymentService hash the
 * same way and the staleness check is symmetric.
 *
 * A UNION node's second input and its column-merge policy live at CONFIG
 * level — `unionApply` writes `config.rightNodeId` / `config.rightNodeIds`
 * and `config.mode`, deliberately NOT into `config.transforms` — so hashing
 * the transform array alone left the deploy gate (previewPinning) unable to
 * see a swapped union input or a `strict` -> `wide` policy change. That is
 * the dangerous direction: the gate exists to catch "the canvas preview no
 * longer matches what deploy will execute", and for union nodes it was blind.
 *
 * So the union wiring is folded into the payload whenever it exists. Nodes
 * with no union keep the exact historical payload (the bare transform array),
 * which means every non-union snapshot captured before this change still
 * hashes identically and no unrelated pipeline is suddenly PREVIEW_STALE.
 * Union snapshots captured before this change DO hash differently and will be
 * reported stale once — that is the intended fail-closed direction: their old
 * hash never covered the wiring, so it cannot be trusted to certify it.
 */
export function chainHashFromNodeConfig(config: unknown): string {
  const cfg = (config ?? {}) as {
    transforms?: unknown;
    rightNodeId?: unknown;
    rightNodeIds?: unknown;
    mode?: unknown;
  };
  const transforms = Array.isArray(cfg.transforms) ? cfg.transforms : [];
  const rightNodeIds = Array.isArray(cfg.rightNodeIds)
    ? cfg.rightNodeIds.filter((v): v is string => typeof v === 'string')
    : (typeof cfg.rightNodeId === 'string' ? [cfg.rightNodeId] : []);
  if (rightNodeIds.length === 0) return hashTransformChain(transforms);
  return hashTransformChain({
    transforms,
    union: {
      rightNodeIds,
      mode: typeof cfg.mode === 'string' ? cfg.mode : null,
    },
  });
}
