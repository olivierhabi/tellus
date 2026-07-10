import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// partitionedMerge.ts
//
// External hash-partitioned PK dedup with "last row wins" semantics — the
// bounded-memory replacement for `reindexService`'s in-memory
// `objectMap: Map<pk, doc>` (which OOMs at ~1.8 GB for 5.6 M docs and has a
// hard ceiling well before real-world scale).
//
// Two passes, both memory-bounded:
//   Pass 1 (partition): stream the input rows; route each to spill file
//     `part_<hash(pk) mod N>` by appending a serialized line. Memory =
//     the read stream + N write-stream buffers (~N × highWaterMark).
//   Pass 2 (merge):      for each partition file, load it into memory
//     (bounded by ~datasetSize/N, the largest partition), build a
//     Map<pk, lastRow>, yield the merged docs. One partition resident at a
//     time.
//
// Correctness: every row sharing a PK lands in the SAME partition (hash is
// a pure function of the PK), so last-wins within a partition == last-wins
// globally. The union of per-partition outputs is the full merged set with
// no cross-partition coordination needed.
//
// Spill is local-disk by default (bounded by DISK, not memory — the
// standard external-merge trade). For datasets larger than local disk,
// point `spillDir` at an S3/MinIO-backed path (the write/merge API is
// stream-based so an S3 spill is a drop-in). No DuckDB required.
// ---------------------------------------------------------------------------

export interface PartitionedMergeOptions {
  /** Column whose value is the primary key (dedup key). */
  primaryKeyColumn: string;
  /** Number of hash partitions. Default 64. Larger = less memory, more files. */
  partitionCount?: number;
  /** Directory for spill files. Default os.tmpdir(). */
  spillDir?: string;
  /** Prefix for the spill files. Default "tellus-merge". */
  spillPrefix?: string;
  /**
   * Called for each yielded merged doc, after the merge. Lets the caller
   * apply per-doc transforms (e.g. ontology column-mapping + type
   * conversion) without materializing the whole set. Optional.
   */
  onMerged?: (doc: Record<string, unknown>) => Record<string, unknown>;
}

export interface PartitionedMergeStats {
  totalRows: number;
  distinctCount: number;
  duplicateCount: number;
  partitionCount: number;
  spillFiles: string[];
  peakPartitionRows: number;
}

const DEFAULT_PARTITION_COUNT = 64;

/**
 * FNV-1a 32-bit hash. Fast + distributes well over hex-UUID-shaped PKs
 * (a naive char-sum hash skews on hex input). Used only to pick a
 * partition bucket, so collisions across buckets are fine — correctness
 * only requires that the SAME pk always lands in the SAME bucket.
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function serializeRow(row: Record<string, unknown>): string {
  return JSON.stringify(row);
}

function deserializeRow(line: string): Record<string, unknown> {
  return JSON.parse(line);
}

/**
 * Dedup-by-PK ("last row wins") over an async row stream, memory-bounded
 * by partition size, not dataset size. Yields merged docs one at a time
 * (so the caller — the OpenSearch bulk indexer — can batch them without
 * materializing the full merged set).
 *
 * Stats are passed to the optional `onStats` callback once the run settles
 * (after the partition pass + as partitions are merged). The async
 * generator model means the partition pass runs to completion before the
 * first merged doc is yielded (a PK's rows must all be in one spill file
 * before last-wins can be resolved).
 */
export async function* externalHashMerge(
  rows: AsyncIterable<Record<string, unknown>>,
  opts: PartitionedMergeOptions,
  onStats?: (stats: PartitionedMergeStats) => void,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  const partitionCount = opts.partitionCount ?? DEFAULT_PARTITION_COUNT;
  const spillDir = opts.spillDir ?? os.tmpdir();
  const prefix = opts.spillPrefix ?? "tellus-merge";

  // --- Pass 1: partition into N spill files -------------------------------
  // Open N write streams. Each row → append a line to part_<hash(pk) mod N>.
  const spillFiles: string[] = [];
  const writers: fs.WriteStream[] = [];
  for (let i = 0; i < partitionCount; i++) {
    const file = path.join(spillDir, `${prefix}-part${i}-${process.pid}.jsonl`);
    spillFiles.push(file);
    const ws = fs.createWriteStream(file);
    writers.push(ws);
  }

  let totalRows = 0;
  const pkCol = opts.primaryKeyColumn;
  for await (const row of rows) {
    totalRows++;
    const pkRaw = row[pkCol];
    const pkStr =
      pkRaw === null || pkRaw === undefined ? "" : String(pkRaw);
    const bucket = fnv1a32(pkStr) % partitionCount;
    // Append a serialized line + newline. WriteStream buffers internally
    // (highWaterMark) so this is bounded memory across N streams.
    if (!writers[bucket].write(`${serializeRow(row)}\n`)) {
      // Backpressure: the stream's internal buffer is full — wait for
      // 'drain' before continuing, so the partition pass can't accumulate
      // unbounded in-memory data if a spill disk is slow.
      await new Promise<void>((r) => writers[bucket].once("drain", r));
    }
  }
  // Flush + close all spill writers.
  await Promise.all(
    writers.map((w) => new Promise<void>((resolve) => w.end(resolve))),
  );

  // --- Pass 2: merge each partition, one resident at a time --------------
  let distinctCount = 0;
  let duplicateCount = 0;
  let peakPartitionRows = 0;

  for (let i = 0; i < partitionCount; i++) {
    const file = spillFiles[i];
    let lines: string[];
    try {
      lines = fs.readFileSync(file, "utf-8").split("\n");
    } catch {
      // Empty/missing partition (no rows hashed here) — nothing to merge.
      continue;
    }
    // split always leaves a trailing "" after the final newline.
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) continue;

    if (lines.length > peakPartitionRows) peakPartitionRows = lines.length;

    // Last-wins per PK within this partition. Bounded by the partition's
    // distinct-key count (≤ lines.length ≤ ~datasetSize/N).
    const merged = new Map<string, Record<string, unknown>>();
    for (const line of lines) {
      const row = deserializeRow(line);
      const pkRaw = row[pkCol];
      const pkStr =
        pkRaw === null || pkRaw === undefined ? "" : String(pkRaw);
      if (merged.has(pkStr)) {
        duplicateCount++;
      } else {
        distinctCount++;
      }
      merged.set(pkStr, row); // last row wins
    }

    // Yield this partition's merged docs, then drop the map before loading
    // the next partition (so only one partition is resident at a time).
    for (const doc of merged.values()) {
      yield opts.onMerged ? opts.onMerged(doc) : doc;
    }
    merged.clear();

    // Clean up the spill file as we go so disk usage stays bounded too.
    try { fs.unlinkSync(file); } catch { /* best-effort */ }
  }

  if (onStats) {
    onStats({
      totalRows,
      distinctCount,
      duplicateCount,
      partitionCount,
      spillFiles: [],
      peakPartitionRows,
    });
  }
}
