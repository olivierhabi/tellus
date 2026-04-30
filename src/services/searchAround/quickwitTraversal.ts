// ---------------------------------------------------------------------------
// Quickwit-only traversal — Task B10 (fast path, hops ≤ 100k)
//
// Uses Quickwit's `search_stream` endpoint to stream u64 fast-field values
// (linked PKs) at 3M+ rows/sec. The fetched PK set becomes a TermSet
// filter for the next hop's Quickwit query.
//
// search_stream semantics:
//   POST /api/v1/<index>/search/stream
//   body: { query, fast_field, output_format: "clickHouseRowBinary" }
//
// We request `csv` output_format for readability in this path — Quickwit
// supports csv/click-house row-binary. CSV is good enough; the bottleneck
// is the downstream TermSet filter, not the wire format.
// ---------------------------------------------------------------------------

import { QuickwitClient, getQuickwitClient } from "../quickwit/client";
import { LinkTypeDescriptor, linkTableName } from "./linkMaterializedView";

export interface QuickwitHopInput {
  objectTypeApiName: string; // source Object Type (e.g. "Order")
  startPks: string[];        // source PK set
  linkType: LinkTypeDescriptor;
  pkFastFieldName?: string;  // target PK field on the source index — default "__pk"
  maxPks?: number;           // cap for this hop — default 100_000
  /**
   * When present, the markings a user is cleared for. The hop filters the
   * Quickwit query down to link docs whose markings are a subset of this
   * set — the authoritative post-filter still runs in searchAroundService,
   * but pushing the predicate into Quickwit avoids streaming PKs the
   * caller will then immediately drop.
   */
  userMarkings?: ReadonlySet<string>;
  client?: QuickwitClient;
}

export interface QuickwitHopResult {
  targetPks: string[];
  scannedDocs: number;
  durationMs: number;
  viaBackend: "quickwit";
}

export const MAX_QUICKWIT_HOP_SIZE = 100_000;

export async function runQuickwitHop(input: QuickwitHopInput): Promise<QuickwitHopResult> {
  const started = Date.now();
  if (input.startPks.length === 0) {
    return { targetPks: [], scannedDocs: 0, durationMs: 0, viaBackend: "quickwit" };
  }
  const client = input.client ?? getQuickwitClient();
  const max = input.maxPks ?? MAX_QUICKWIT_HOP_SIZE;
  if (input.startPks.length > max) {
    throw new QuickwitHopTooLargeError(input.startPks.length, max);
  }

  // Quickwit link "search_stream" needs an index that carries the target
  // PK as a fast field. For link-style traversals we expect a link-level
  // materialized index ot_link_<source>__<name>__<target> with __pk on
  // source side and a `target_pk` fast field. The module doesn't create
  // this index — that's B6's job — but it *does* route the query here.
  const linkIndex = `ot_${linkTableName(input.linkType)}`;
  const fastField = input.pkFastFieldName ?? "target_pk";

  const termSet = input.startPks.map((pk) => `"${escape(pk)}"`).join(" OR ");
  let queryStr = `source_pk:(${termSet})`;
  if (input.userMarkings && input.userMarkings.size > 0) {
    // markings on a link are AND-composed from the user's perspective
    // (the user must hold ALL of the link's markings to see it). Quickwit
    // can't express an AND-subset directly, so we drop link docs that
    // reference any marking NOT in the user's set. The service-layer
    // post-filter still enforces strict AND semantics after the hop.
    const withheld = `markings:* AND NOT markings:(${escapeMarkingSet(
      input.userMarkings
    )})`;
    queryStr = `(${queryStr}) AND NOT (${withheld})`;
  } else if (input.userMarkings && input.userMarkings.size === 0) {
    // User has no markings → only see link docs with empty markings.
    queryStr = `(${queryStr}) AND NOT markings:*`;
  }

  const streamed = await searchStream(client, linkIndex, queryStr, fastField);
  return {
    targetPks: streamed.values,
    scannedDocs: streamed.scannedDocs,
    durationMs: Date.now() - started,
    viaBackend: "quickwit",
  };
}

/** Quickwit /search/stream → list of fast-field values. */
async function searchStream(
  client: QuickwitClient,
  indexId: string,
  query: string,
  fastField: string
): Promise<{ values: string[]; scannedDocs: number }> {
  // /search/stream emits the fast-field column at multi-million rows/sec.
  // We pull CSV for ergonomics; callers that need row-binary can extend
  // the client options.
  const streamed = await client.searchStream(indexId, {
    query,
    fastField,
    outputFormat: "csv",
    searchFields: ["source_pk"],
  });
  const values = streamed.filter((v): v is string => typeof v === "string" && v.length > 0);
  return { values: dedupe(values), scannedDocs: values.length };
}

function escape(pk: string): string {
  return pk.replace(/"/g, '\\"');
}

function escapeMarkingSet(ms: ReadonlySet<string>): string {
  return Array.from(ms)
    .map((m) => `"${m.replace(/"/g, '\\"')}"`)
    .join(" OR ");
}

function dedupe<T>(xs: T[]): T[] {
  const s = new Set<T>();
  const out: T[] = [];
  for (const x of xs) {
    if (!s.has(x)) {
      s.add(x);
      out.push(x);
    }
  }
  return out;
}

export class QuickwitHopTooLargeError extends Error {
  constructor(public readonly size: number, public readonly max: number) {
    super(
      `Quickwit hop of ${size} PKs exceeds the ${max} fast-path cap; escalate to ClickHouse`
    );
    this.name = "QuickwitHopTooLargeError";
  }
}
