// Quiver B4 — DocumentDiff utility.
//
// Coverage:
//   B4 C-06: computeDiff(a, b) returns added/removed/modified card lists +
//            per-card config JSON Patch (RFC 6902); symmetric & stable.

import type { AnalysisDocument } from "./types";

export interface CardDiffEntry {
  cardId: string;
  /** RFC 6902 patch operations to transform `a.config` into `b.config`. */
  configPatch: JsonPatchOp[];
  /** True when the card's `type` differs (effectively a replace). */
  typeChanged: boolean;
  /** True when the inputs map differs. */
  inputsChanged: boolean;
}

export interface DocumentDiff {
  added: string[];
  removed: string[];
  modified: CardDiffEntry[];
  canvasesChanged: boolean;
  parametersChanged: boolean;
}

export interface JsonPatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
}

/**
 * Symmetric on swap: `computeDiff(a, b)` and `computeDiff(b, a)` produce
 * the same `added/removed` *cardinality* with roles swapped. Stable across
 * calls — sorting is applied to every collection.
 */
export function computeDiff(
  a: Pick<AnalysisDocument, "cards" | "canvases" | "parameters">,
  b: Pick<AnalysisDocument, "cards" | "canvases" | "parameters">,
): DocumentDiff {
  const aIds = new Set(Object.keys(a.cards));
  const bIds = new Set(Object.keys(b.cards));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: CardDiffEntry[] = [];

  for (const id of bIds) if (!aIds.has(id)) added.push(id);
  for (const id of aIds) if (!bIds.has(id)) removed.push(id);
  added.sort();
  removed.sort();

  for (const id of [...aIds].sort()) {
    if (!bIds.has(id)) continue;
    const ca = a.cards[id];
    const cb = b.cards[id];
    if (!ca || !cb) continue;
    const configPatch = jsonPatch(ca.config ?? {}, cb.config ?? {});
    const typeChanged = ca.type !== cb.type;
    const inputsChanged = !shallowEq(ca.inputs ?? {}, cb.inputs ?? {});
    if (configPatch.length > 0 || typeChanged || inputsChanged) {
      modified.push({ cardId: id, configPatch, typeChanged, inputsChanged });
    }
  }

  return {
    added,
    removed,
    modified,
    canvasesChanged: !deepEq(a.canvases ?? [], b.canvases ?? []),
    parametersChanged: !deepEq(a.parameters ?? {}, b.parameters ?? {}),
  };
}

function shallowEq(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    if (a[ak[i]] !== b[bk[i]]) return false;
  }
  return true;
}

function deepEq(a: unknown, b: unknown): boolean {
  return canonicalJsonStr(a) === canonicalJsonStr(b);
}

/** Stable canonical JSON for equality checks. Sorts object keys. */
function canonicalJsonStr(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJsonStr).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canonicalJsonStr((v as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/**
 * Minimal RFC 6902 patch generator scoped to the shapes Quiver card configs
 * use (objects-of-scalars-or-objects, no arrays-with-identity tracking).
 * For arrays we emit a single `replace` op rather than diffing element-wise.
 */
export function jsonPatch(a: unknown, b: unknown, base = ""): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  if (canonicalJsonStr(a) === canonicalJsonStr(b)) return ops;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  ) {
    ops.push({ op: "replace", path: base || "/", value: b });
    return ops;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    ops.push({ op: "replace", path: base || "/", value: b });
    return ops;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of Object.keys(bo).sort()) {
    const path = base + "/" + jsonPointerEscape(k);
    if (!(k in ao)) {
      ops.push({ op: "add", path, value: bo[k] });
    } else {
      ops.push(...jsonPatch(ao[k], bo[k], path));
    }
  }
  for (const k of Object.keys(ao).sort()) {
    if (!(k in bo)) {
      ops.push({ op: "remove", path: base + "/" + jsonPointerEscape(k) });
    }
  }
  return ops;
}

function jsonPointerEscape(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}
