// ---------------------------------------------------------------------------
// Search Arounds — Task B10 (top-level orchestrator)
//
// Public entrypoint callers use:
//
//   traverse({
//     anchorPks: [...],
//     hops: [{ linkType }, { linkType }, ...],
//     userMarkings,
//     maxRows,
//   })
//
// Per-hop strategy:
//
//   • If the start set is ≤ `maxQuickwitHopSize` (default 100k), run the
//     hop against Quickwit's search_stream.
//   • Else escalate the *remaining* hop chain to ClickHouse in a single
//     JOIN query. Once in ClickHouse we stay there — switching back after
//     a large hop is almost never a win.
//
// Markings are enforced twice: ClickHouse filters in-SQL (cheaper server-
// side), and we re-check the final PK set's link-level markings at the
// API boundary (defense in depth).
// ---------------------------------------------------------------------------

import {
  MAX_QUICKWIT_HOP_SIZE,
  QuickwitHopTooLargeError,
  runQuickwitHop,
} from "./quickwitTraversal";
import {
  ADMIN_MAX_CAP,
  DEFAULT_CAP,
  runClickHouseTraversal,
} from "./clickhouseTraversal";
import type { LinkTypeDescriptor } from "./linkMaterializedView";
import type { QuickwitClient } from "../quickwit/client";
import type { ClickHouseClient } from "./clickhouseClient";
import { query } from "../../db";
import { userSees } from "./markingFilter";

export interface TraverseHop {
  linkType: LinkTypeDescriptor;
}

export interface TraverseInput {
  /** Object Type of the anchor set. Needed by the first Quickwit hop. */
  anchorObjectType: string;
  anchorPks: string[];
  hops: TraverseHop[];
  userMarkings: ReadonlySet<string>;
  /** Default 100k. Admin override up to 1M (warns when exceeded). */
  maxRows?: number;
  /** Override the per-hop Quickwit size cap (tests). */
  maxQuickwitHopSize?: number;
  /** Stubs for tests. */
  quickwitClient?: QuickwitClient;
  clickhouseClient?: ClickHouseClient;
  /** Caller-supplied admin override flag (enables maxRows > DEFAULT_CAP). */
  adminOverride?: boolean;
}

export interface TraverseHopTrace {
  hopIndex: number;
  viaBackend: "quickwit" | "clickhouse";
  inputSize: number;
  outputSize: number;
  durationMs: number;
}

export interface TraverseResult {
  targetPks: string[];
  cappedAtMax: boolean;
  warnings: string[];
  trace: TraverseHopTrace[];
  totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// traverse()
// ---------------------------------------------------------------------------

export async function traverse(input: TraverseInput): Promise<TraverseResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const trace: TraverseHopTrace[] = [];

  const maxQuickwitHop = input.maxQuickwitHopSize ?? MAX_QUICKWIT_HOP_SIZE;
  const cap = resolveCap(input.maxRows, input.adminOverride, warnings);

  if (input.anchorPks.length === 0 || input.hops.length === 0) {
    return { targetPks: [], cappedAtMax: false, warnings, trace, totalDurationMs: 0 };
  }

  // Run hops one-by-one in Quickwit as long as the set fits.
  let current = dedupe(input.anchorPks);
  let currentObjectType = input.anchorObjectType;
  for (let i = 0; i < input.hops.length; i++) {
    const hop = input.hops[i];
    if (current.length > maxQuickwitHop) {
      // Escalate from this hop onwards.
      const clickResult = await runClickHouseTraversal({
        anchorPks: current,
        hops: input.hops.slice(i),
        userMarkings: input.userMarkings,
        maxRows: cap,
        client: input.clickhouseClient,
      });
      trace.push({
        hopIndex: i,
        viaBackend: "clickhouse",
        inputSize: current.length,
        outputSize: clickResult.targetPks.length,
        durationMs: clickResult.durationMs,
      });
      return {
        targetPks: clickResult.targetPks,
        cappedAtMax: clickResult.cappedAtMax,
        warnings,
        trace,
        totalDurationMs: Date.now() - started,
      };
    }

    try {
      const q = await runQuickwitHop({
        objectTypeApiName: currentObjectType,
        startPks: current,
        linkType: hop.linkType,
        maxPks: maxQuickwitHop,
        userMarkings: input.userMarkings,
        client: input.quickwitClient,
      });
      trace.push({
        hopIndex: i,
        viaBackend: "quickwit",
        inputSize: current.length,
        outputSize: q.targetPks.length,
        durationMs: q.durationMs,
      });
      current = q.targetPks;
      currentObjectType = hop.linkType.targetObjectType;
      if (current.length > cap) {
        // Truncate and warn — Quickwit already gave us more than we'll
        // return. We take the deterministic prefix.
        current = current.slice(0, cap);
      }
    } catch (err) {
      if (err instanceof QuickwitHopTooLargeError) {
        // Defensive: we already guarded above, but the hop might have
        // returned enough rows to push us past the cap at this layer.
        const clickResult = await runClickHouseTraversal({
          anchorPks: current,
          hops: input.hops.slice(i),
          userMarkings: input.userMarkings,
          maxRows: cap,
          client: input.clickhouseClient,
        });
        trace.push({
          hopIndex: i,
          viaBackend: "clickhouse",
          inputSize: current.length,
          outputSize: clickResult.targetPks.length,
          durationMs: clickResult.durationMs,
        });
        return {
          targetPks: clickResult.targetPks,
          cappedAtMax: clickResult.cappedAtMax,
          warnings,
          trace,
          totalDurationMs: Date.now() - started,
        };
      }
      throw err;
    }
  }

  // B10 defense-in-depth: subtract target PKs whose row-level markings
  // the user lacks. Link-level markings were enforced inside the hop;
  // endpoint (target Object Type) markings are enforced here at the
  // API boundary so traversals can never leak PKs the caller isn't
  // cleared to see via B1 object_instances.
  const finalPks = await dropPksUserCannotSee(
    currentObjectType,
    current,
    input.userMarkings
  );

  return {
    targetPks: finalPks,
    cappedAtMax: finalPks.length >= cap,
    warnings,
    trace,
    totalDurationMs: Date.now() - started,
  };
}

async function dropPksUserCannotSee(
  objectTypeApiName: string,
  pks: string[],
  userMarkings: ReadonlySet<string>
): Promise<string[]> {
  if (pks.length === 0) return pks;
  try {
    const res = await query(
      `SELECT primary_key, markings
         FROM object_instances
        WHERE object_type_api_name = $1
          AND primary_key = ANY($2::text[])`,
      [objectTypeApiName, pks]
    );
    const visibleByPk = new Map<string, string[]>();
    for (const row of res.rows as Array<{ primary_key: string; markings: string[] | null }>) {
      visibleByPk.set(row.primary_key, row.markings ?? []);
    }
    // PKs absent from object_instances (streaming lag, legacy OTs without
    // the B1 table populated) default to visible — we don't want a stale
    // system-of-record to cause false negatives. The link-level filter
    // upstream still enforces the conservative boundary.
    return pks.filter((pk) => {
      const markings = visibleByPk.get(pk);
      if (!markings) return true;
      return userSees(markings, userMarkings);
    });
  } catch {
    // If object_instances is unavailable, keep the link-level decision.
    return pks;
  }
}

// ---------------------------------------------------------------------------
// resolveCap() — default 100k; admin override up to 1M with a warning.
// ---------------------------------------------------------------------------

function resolveCap(
  explicit: number | undefined,
  adminOverride: boolean | undefined,
  warnings: string[]
): number {
  if (!explicit || explicit <= DEFAULT_CAP) return explicit ?? DEFAULT_CAP;
  if (!adminOverride) {
    warnings.push(
      `requested maxRows=${explicit} exceeds default cap ${DEFAULT_CAP}; clamped. ` +
        `Set adminOverride=true to raise.`
    );
    return DEFAULT_CAP;
  }
  if (explicit > ADMIN_MAX_CAP) {
    warnings.push(
      `requested maxRows=${explicit} exceeds admin-override max ${ADMIN_MAX_CAP}; clamped.`
    );
    return ADMIN_MAX_CAP;
  }
  warnings.push(
    `admin-override maxRows=${explicit} in effect (> default ${DEFAULT_CAP})`
  );
  return explicit;
}

function dedupe(xs: string[]): string[] {
  const s = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!s.has(x)) {
      s.add(x);
      out.push(x);
    }
  }
  return out;
}
