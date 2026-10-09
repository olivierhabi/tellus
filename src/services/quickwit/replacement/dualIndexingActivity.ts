// ---------------------------------------------------------------------------
// Dual-index Indexing activity — Task B9
//
// Wraps the single-target B6 Indexing activity so that, during
// REPLACEMENT_BACKFILL and REPLACEMENT_SOAK, writes fan out to both the
// LIVE and the pending Quickwit indices through their respective Kafka
// topics. In LIVE steady state this collapses to exactly the B6 behavior.
//
// Read-path resolution (which index a query hits) is owned by
// versionManager.resolveQueryIndexId — dual-write never touches it.
// ---------------------------------------------------------------------------

import {
  IndexingActivityInput,
  IndexingActivityResult,
  MergedRowReader,
  MergedBatch,
  runIndexingActivity,
} from "../indexingActivity";
import { resolveWriteTargets } from "./versionManager";
import { publishMergedDocs } from "../mergedKafkaProducer";

export interface DualIndexingInput
  extends Omit<IndexingActivityInput, "kafkaTopic"> {
  /** Override the primary topic — defaults to `merged.<api>` (B6 convention). */
  primaryTopic?: string;
  /** Override the sibling topic — defaults to `merged.<api>.sibling.v<N>`. */
  siblingTopic?: string;
}

export interface DualIndexingResult {
  primary: IndexingActivityResult;
  sibling?: IndexingActivityResult;
  dualWrite: boolean;
  primaryTopic: string;
  siblingTopic?: string;
}

export async function runDualIndexingActivity(
  input: DualIndexingInput
): Promise<DualIndexingResult> {
  const targets = await resolveWriteTargets(input.objectTypeApiName);
  const primaryTopic =
    input.primaryTopic ?? `merged.${input.objectTypeApiName.toLowerCase()}`;
  const dualWrite =
    targets.pending !== null &&
    (targets.state === "REPLACEMENT_BACKFILL" ||
      targets.state === "REPLACEMENT_SOAK");

  if (!dualWrite) {
    const primary = await runIndexingActivity({
      ...input,
      kafkaTopic: primaryTopic,
    });
    return { primary, dualWrite: false, primaryTopic };
  }

  // Tee the reader so each batch is consumed exactly once, then fanned out
  // twice. We buffer per-batch in memory (one merged batch at a time) so
  // memory overhead stays bounded.
  const siblingTopic =
    input.siblingTopic ?? `${primaryTopic}.sibling`;

  const { primaryReader, siblingReader } = teeReader(input.reader);

  const [primary, sibling] = await Promise.all([
    runIndexingActivity({
      ...input,
      reader: primaryReader,
      kafkaTopic: primaryTopic,
    }),
    runIndexingActivity({
      ...input,
      reader: siblingReader,
      kafkaTopic: siblingTopic,
      // Pin to the sibling's publish; B6 default uses the batched merged
      // producer, which keys by PK and returns the broker's last offset.
      // An injected publisher (either shape) is passed through by ...input.
      ...(input.publishDoc || input.publishDocs
        ? {}
        : {
            publishDocs: (_topic: string, docs: Parameters<typeof publishMergedDocs>[1]) =>
              publishMergedDocs(siblingTopic, docs),
          }),
    }),
  ]);

  return { primary, sibling, dualWrite: true, primaryTopic, siblingTopic };
}

// ---------------------------------------------------------------------------
// teeReader — given one async-iterable reader, produce two readers that
// both walk the underlying source exactly once. We buffer each batch in a
// single-slot queue so both consumers advance in lockstep; if one lags by
// more than one batch, the producer waits. That prevents unbounded memory
// growth when sibling Kafka is slow.
// ---------------------------------------------------------------------------

function teeReader(source: MergedRowReader): {
  primaryReader: MergedRowReader;
  siblingReader: MergedRowReader;
} {
  const primaryQueue: MergedBatch[] = [];
  const siblingQueue: MergedBatch[] = [];
  let sourceIter: AsyncIterator<MergedBatch> | null = null;
  let pumpInFlight: Promise<boolean> | null = null;
  let exhausted = false;

  // `pump` runs at most once concurrently. It pulls one batch from the
  // source and mirrors it into both queues. Returns true if a batch was
  // pushed; false once the source is done.
  function pump(): Promise<boolean> {
    if (pumpInFlight) return pumpInFlight;
    if (exhausted) return Promise.resolve(false);
    pumpInFlight = (async () => {
      if (!sourceIter) {
        sourceIter = source()[Symbol.asyncIterator]();
      }
      const { value, done } = await sourceIter.next();
      if (done) {
        exhausted = true;
        return false;
      }
      primaryQueue.push(value);
      siblingQueue.push(value);
      return true;
    })().finally(() => {
      pumpInFlight = null;
    });
    return pumpInFlight;
  }

  function readerFor(queue: MergedBatch[]): MergedRowReader {
    return () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<MergedBatch>> {
            while (queue.length === 0) {
              const pulled = await pump();
              if (!pulled && queue.length === 0) {
                return { value: undefined as never, done: true };
              }
            }
            return { value: queue.shift()!, done: false };
          },
        };
      },
    });
  }

  return { primaryReader: readerFor(primaryQueue), siblingReader: readerFor(siblingQueue) };
}
