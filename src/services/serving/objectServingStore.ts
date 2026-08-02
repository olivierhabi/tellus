// ---------------------------------------------------------------------------
// Stage-5 — ObjectServingStore (production routing).
//
// Capability slice #1: `GET /api/v1/objects/:objectType/:primaryKey`.
//
// The store keeps the pre-existing hit-emissions shape: merged behavior
// of the route (overlay-aware + audit + property/cell redaction) stays in
// the route handler layer while THIS module owns the mode selection —
// serving-store mode is read ONCE per call and dispatched deterministically:
//   * legacy  — pre-cutover path: executeGetObject() (current behavior).
//   * shadow  — both paths + digest-compared, caller still gets legacy's
//     shape (canonicalized bits logged with counts+digests only).
//   * indexed — the store's own call: same shape, sourced further through
//     an injected `resolveDoc(index-name-based)` — an INJECTED adapter so
//     alternating between Quickwit/OS+elastic-search sources is
//     pluggable (not toggled IN-place).
// ---------------------------------------------------------------------------

import { resolveServingMode } from "./servingFlags";
import { compareShadow } from "./shadowCompare";
import { incCounter } from "../funnel/metrics";
import type { IsolationScope } from "./contracts";

export interface ObjectGetArgs {
  objectTypeApiName: string;
  primaryKey: string;
  /** the caller's branch scope, married during dispatch */
  scope: IsolationScope;
}

export interface ServingObjectServingStore {
  get(args: ObjectGetArgs): Promise<Record<string, unknown> | null>;
}

/** A fixture the caller provides: the outgoing legacy getter. */
export type LegacyGetObjectFn = (objectTypeApiName: string, primaryKey: string) => Promise<Record<string, unknown> | null>;
/** The serving-index primary resolution — must honour the same input shape. */
export type IndexedGetObjectFn = (args: ObjectGetArgs) => Promise<Record<string, unknown> | null>;

export async function objectServingStoreGet(
  args: ObjectGetArgs,
  legacyGet: LegacyGetObjectFn,
  indexedGet: IndexedGetObjectFn,
): Promise<Record<string, unknown> | null> {
  const mode = await resolveServingMode({ capability: "objects.get" });
  incCounter("serving_store_object_mode_total", { capability: "objects.get", mode });
  if (mode === "indexed") {
    return indexedGet(args);
  }
  if (mode === "legacy") {
    return legacyGet(args.objectTypeApiName, args.primaryKey);
  }
  // shadow: run both sides and compare CANONICAL digests of the payloads.
  // The primary is still legacy — this is the pre-cutover window — and
  // mismatch results get counted + digests logged (no payload content).
  const canonicalize = (d: Record<string, unknown> | null): { pks: string[] } => {
    if (!d) return { pks: [] };
    const pk = String((d as { __pk?: unknown }).__pk ?? "");
    const props = JSON.stringify(
      Object.entries(d)
        .filter(([k]) => k !== "__pk")
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    return { pks: [`${pk}:${props}`] };
  };
  const { pks, report } = await compareShadow({
    capability: "objects.get",
    scopeKey: args.objectTypeApiName,
    legacyFn: async () => canonicalize(await legacyGet(args.objectTypeApiName, args.primaryKey)),
    indexedFn: async () => canonicalize(await indexedGet(args)),
    primary: "legacy",
  });
  void pks;
  void report; // digests+counters are the only sides that matter here
  return legacyGet(args.objectTypeApiName, args.primaryKey);
}
