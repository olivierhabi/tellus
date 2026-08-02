// ---------------------------------------------------------------------------
// Indexed LinkServingStore — resolves M2M edges from the versioned
// ClickHouse edge index (ReplacingMergeTree + argMax latest-state,
// tenant/ontology/branch isolation in the key and every predicate,
// fail-closed edge + endpoint security). CSV join tables and Iceberg are
// NEVER consulted here.
//
// Used by routes through the edgeResolver seam in
// linkResolverService.searchAround() — object hydration, filters,
// pagination and response shape remain shared with the pre-cutover code,
// which keeps the public contract bit-identical while the edge lookup
// moves to the serving index.
// ---------------------------------------------------------------------------

import {
  buildReverseSql,
  runClickHouseTraversal,
} from "../searchAround/clickhouseTraversal";
import { getClickHouseClient } from "../searchAround/clickhouseClient";
import { resolveLegacyCsvM2mPks } from "../linkResolverService";
import { deriveMainBranchId } from "../branchContext";
import { waitForLinkWatermark, type EdgeAckDeps } from "./edgeIndexWatermark";
import type { LinkTypeRow } from "../../models/linkType";
import type { IsolationScope } from "./contracts";

const DEFAULT_EDGE_CAP = 100_000;

export interface EdgeResolutionContext {
  linkType: LinkTypeRow;
  direction: "forward" | "reverse";
  branchId: string | null; // from the request branch header; null ⇒ main
  userMarkings: ReadonlySet<string>;
  tenantId: string;
  /** API names (the link_type.profile.sources uuid columns are IDs) — resolved during weigh-time. */
  sourceOtApiName: string;
  targetOtApiName: string;
}

function toScope(ctx: EdgeResolutionContext): IsolationScope {
  // readBranchHeader returns null on the default branch; the edge rows'
  // branch_id dimension is stamped from the execution context at write
  // time (link_edit.branch_id), which for a main-branch write is the
  // branch row id — see editApplicator.
  return {
    tenantId: ctx.tenantId,
    ontologyId: ctx.linkType.ontology_id,
    branchId: ctx.branchId ?? deriveMainBranchId(ctx.linkType.ontology_id),
  };
}

/**
 * Forward lookup: anchor sources → targets DIRECTLY from the versioned
 * edge index. Rationale (Stage 8): the LinkServingStore serves from the
 * ClickHouse store ONLY — Quickwit is NOT part of the store's data path;
 * an outage there must never translate into store unavailability. This
 * runs the same runClickHouseTraversal SQL-shape the reverse flow uses,
 * with the isolation + cap guards it enforces.
 */
async function resolveForward(ctx: EdgeResolutionContext, anchorPks: string[]): Promise<string[]> {
  const lt = ctx.linkType;
  const out = await runClickHouseTraversal({
    anchorPks,
    hops: [
      {
        linkType: {
          sourceObjectType: ctx.sourceOtApiName,
          linkName: lt.api_name,
          targetObjectType: ctx.targetOtApiName,
        },
      },
    ],
    userMarkings: ctx.userMarkings,
    isolation: toScope(ctx),
  });
  return out.targetPks;
}

/**
 * Reverse lookup: anchor targets → sources via the argMax reverse
 * projection of the same edge table.
 */
async function resolveReverse(ctx: EdgeResolutionContext, anchorPks: string[]): Promise<string[]> {
  const sql = buildReverseSql({
    linkType: {
      sourceObjectType: ctx.linkType.source_object_type,
      linkName: ctx.linkType.api_name,
      targetObjectType: ctx.linkType.target_object_type,
    },
    anchorPks,
    userMarkings: ctx.userMarkings,
    isolation: toScope(ctx),
    cap: DEFAULT_EDGE_CAP,
  });
  const rows = await getClickHouseClient().exec<{ pk: string }>(sql);
  return rows.map((r) => r.pk);
}

/** resolveLinkedPks — the LinkServingStore.traverse() entry for routes. */
export async function resolveLinkedPks(
  ctx: EdgeResolutionContext,
  anchorPks: string[],
): Promise<string[]> {
  if (anchorPks.length === 0) return [];
  return ctx.direction === "forward"
    ? resolveForward(ctx, anchorPks)
    : resolveReverse(ctx, anchorPks);
}

/** Legacy path (pre-cutover CSV) — used ONLY inside shadow comparisons. */
export function resolveLinkedPksLegacy(
  ctx: EdgeResolutionContext,
  anchorPks: string[],
): string[] {
  return resolveLegacyCsvM2mPks(ctx.linkType, anchorPks, ctx.direction);
}

// ---------------------------------------------------------------------------
// maybeServingEdgeResolver — shared across every public traversal surface.
// Returns undefined when the rollout flag says `legacy` (caller must then
// use the pre-cutover resolver unchanged); otherwise returns the seam fn
// that routes M2M edge resolution through the serving store (indexed) or
// both sides + compare (shadow; returns legacy result).
// ---------------------------------------------------------------------------

export type EdgeResolverFn = (
  sourcePKs: string[],
  direction: "forward" | "reverse",
) => Promise<string[]>;

export interface WeighIn {
  linkType: LinkTypeRow;
  direction: "forward" | "reverse";
  branchId: string | null;
  userMarkings: ReadonlySet<string>;
  tenantId: string;
  /** Capability key — disambiguates per-endpoint rollout. */
  capability: string; // e.g. "links.searchAround" | "oss.traverse"
}

export async function maybeServingEdgeResolver(
  weigh: WeighIn,
): Promise<EdgeResolverFn | undefined> {
  if (weigh.linkType.cardinality !== "MANY_TO_MANY") return undefined;
  const { resolveServingMode } = await import("./servingFlags");
  const { compareShadow } = await import("./shadowCompare");
  const { incCounter } = await import("../funnel/metrics");
  const mode = await resolveServingMode({
    tenantId: weigh.tenantId,
    ontologyId: weigh.linkType.ontology_id,
    branchId: weigh.branchId ?? undefined,
    linkTypeApiName: weigh.linkType.api_name,
    capability: weigh.capability,
  });
  incCounter("serving_store_mode_total", { capability: weigh.capability, mode });
  if (mode === "legacy") return undefined;

  // Serving-table keys derive from API names, while `link_type` stores
  // `source_object_type` / `target_object_type` as UUIDs — resolve once
  // per weigh call (see getObjectTypeApiName — the same helper the
  // pre-cutover flow uses) and rely on the name-stable descriptor for
  // every downstream step.
  const { resolveObjectTypeApiName } = await import("../../models/linkType");
  const [sourceOtApiName, targetOtApiName] = await Promise.all([
    resolveObjectTypeApiName(weigh.linkType.source_object_type),
    resolveObjectTypeApiName(weigh.linkType.target_object_type),
  ]);
  const ctx: EdgeResolutionContext = {
    linkType: weigh.linkType,
    direction: weigh.direction,
    branchId: weigh.branchId,
    userMarkings: weigh.userMarkings,
    tenantId: weigh.tenantId,
    sourceOtApiName,
    targetOtApiName,
  };
  if (mode === "indexed") {
    return (pks) => resolveLinkedPks(ctx, pks);
  }
  // shadow
  return async (pks) => {
    const { pks: chosen, report } = await compareShadow({
      capability: weigh.capability,
      scopeKey: weigh.linkType.api_name,
      legacyFn: async () => ({ pks: resolveLinkedPksLegacy(ctx, pks) }),
      indexedFn: async () => ({ pks: await resolveLinkedPks(ctx, pks) }),
      primary: "legacy",
    });
    incCounter("serving_shadow_compare_returned_total", {
      capability: weigh.capability,
      matched: String(report.match),
    });
    return chosen;
  };
}

// ---------------------------------------------------------------------------
// LinkServingStore.waitForWatermark — SOUND read-after-write barrier.
//
// `minOffset` is an outbox_seq (migration 157) chosen by the caller — the
// Action path passes its staged offset. Resolves only when EVERY published
// outbox row with outbox_seq <= minOffset for the scope is present in the
// versioned edge index (set-difference confirmation; max(seq) alone would
// be unsound under multi-partition delivery). Throws StoreWatermarkTimeout
// on the deadline; a ClickHouse outage blocks until it resolves or the
// deadline expires — never fabricates completion.
// ---------------------------------------------------------------------------
export async function waitForWatermark(args: {
  scope: IsolationScope;
  /** resourceType per the contract: here the link type api name. */
  resourceType: string;
  minOffset: number;
  timeoutMs: number;
  pollMs?: number;
  deps?: EdgeAckDeps;
}): Promise<void> {
  return waitForLinkWatermark({
    scope: args.scope,
    linkTypeApiName: args.resourceType,
    minOffset: args.minOffset,
    timeoutMs: args.timeoutMs,
    pollMs: args.pollMs,
    deps: args.deps,
  });
}
