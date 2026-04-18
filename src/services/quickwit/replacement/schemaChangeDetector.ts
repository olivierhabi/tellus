// ---------------------------------------------------------------------------
// Schema-change detector — Task B9
//
// The Replacement Pipeline is gated by two orthogonal triggers:
//
//   (a) schema change — a property added, removed, retyped, or had its
//       searchable/sortable/filterable flags edited
//   (b) data change   — more than 80% of rows changed in one transaction
//       (Palantir's published heuristic; without this bound, a wholesale
//       refresh is cheaper to apply in-place via the normal Funnel than to
//       stand up a sibling index)
//
// This module compares the current Object Type property bag against a
// baseline snapshot (typically pulled from the live Quickwit index's
// doc_mapping) and returns a structured diff with an explicit
// `replacementRequired` verdict.
// ---------------------------------------------------------------------------

import type { QuickwitPropertyInput } from "../docMapping";

export interface SchemaChange {
  kind: "property_added" | "property_removed" | "property_retyped" | "property_flags_changed";
  propertyApiName: string;
  before?: QuickwitPropertyInput;
  after?: QuickwitPropertyInput;
}

export interface SchemaDiffResult {
  replacementRequired: boolean;
  changes: SchemaChange[];
  reason: string;
}

export function diffPropertyBag(
  previous: QuickwitPropertyInput[],
  next: QuickwitPropertyInput[]
): SchemaDiffResult {
  const byName = (arr: QuickwitPropertyInput[]) =>
    new Map(arr.map((p) => [p.api_name, p]));
  const prev = byName(previous);
  const nxt = byName(next);
  const changes: SchemaChange[] = [];

  for (const [name, p] of nxt) {
    const pprev = prev.get(name);
    if (!pprev) {
      changes.push({ kind: "property_added", propertyApiName: name, after: p });
      continue;
    }
    if (pprev.base_type !== p.base_type || pprev.is_array !== p.is_array) {
      changes.push({
        kind: "property_retyped",
        propertyApiName: name,
        before: pprev,
        after: p,
      });
      continue;
    }
    if (flagsChanged(pprev, p)) {
      changes.push({
        kind: "property_flags_changed",
        propertyApiName: name,
        before: pprev,
        after: p,
      });
    }
  }
  for (const [name, p] of prev) {
    if (!nxt.has(name)) {
      changes.push({ kind: "property_removed", propertyApiName: name, before: p });
    }
  }

  const replacementRequired = changes.some(requiresReplacement);
  const reason = replacementRequired
    ? summarize(changes)
    : changes.length > 0
      ? "no-op flag changes"
      : "no schema changes";

  return { replacementRequired, changes, reason };
}

// ---------------------------------------------------------------------------
// Auto-trigger heuristic: >80% of rows changed in a single transaction.
// Palantir's published threshold. Caller supplies rowsChanged / totalRows
// as observed by the Changelog stage (B4).
// ---------------------------------------------------------------------------

export interface DataVolumeTrigger {
  rowsChanged: number;
  totalRows: number;
}

export interface TriggerVerdict {
  shouldTrigger: boolean;
  reason: string;
  ratio: number;
}

export const AUTO_TRIGGER_THRESHOLD = 0.80;

export function shouldTriggerReplacementForVolume(
  trigger: DataVolumeTrigger
): TriggerVerdict {
  if (trigger.totalRows <= 0) {
    return {
      shouldTrigger: false,
      ratio: 0,
      reason: "totalRows=0 — no baseline to compare against",
    };
  }
  const ratio = trigger.rowsChanged / trigger.totalRows;
  const shouldTrigger = ratio > AUTO_TRIGGER_THRESHOLD;
  return {
    shouldTrigger,
    ratio,
    reason: shouldTrigger
      ? `rowsChanged/${trigger.totalRows} = ${ratio.toFixed(3)} > ${AUTO_TRIGGER_THRESHOLD}`
      : `below auto-trigger threshold (${ratio.toFixed(3)} ≤ ${AUTO_TRIGGER_THRESHOLD})`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagsChanged(a: QuickwitPropertyInput, b: QuickwitPropertyInput): boolean {
  return (
    (a.searchable !== false) !== (b.searchable !== false) ||
    (a.sortable === true) !== (b.sortable === true) ||
    (a.filterable !== false) !== (b.filterable !== false)
  );
}

/**
 * Of the four change kinds, only `property_flags_changed` *might* be safe
 * to apply in place — Quickwit can re-emit segments without a backfill in
 * some cases. We conservatively require replacement for every structural
 * change; callers can override by flipping the returned flag if they know
 * better for a specific deployment.
 */
function requiresReplacement(c: SchemaChange): boolean {
  switch (c.kind) {
    case "property_added":
    case "property_removed":
    case "property_retyped":
      return true;
    case "property_flags_changed":
      return true;
    default:
      return false;
  }
}

function summarize(changes: SchemaChange[]): string {
  const buckets = new Map<SchemaChange["kind"], number>();
  for (const c of changes) buckets.set(c.kind, (buckets.get(c.kind) ?? 0) + 1);
  return Array.from(buckets.entries())
    .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
    .join(", ");
}
