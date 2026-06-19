// Quiver RIDs — UUIDv7 only, time-ordered for index locality (G-01, D-10).
//
// Format: `ri.tellus-quiver.main.<type>.<uuid7>`.
// Types: analysis | dashboard | visual-function | template | working-state | trace.
//
// UUIDv7 layout (RFC 9562 §5.7): 48-bit unix-ts-ms || ver(4)=7 || rand-a(12)
//                              || var(2)=10b || rand-b(62).
// Validators reject any UUID where the version-nibble is not 7 OR the
// variant bits are not 10xx.  This is non-negotiable per spec D-10.

import { v7 as uuidv7 } from "uuid";

export const QUIVER_SERVICE = "tellus-quiver" as const;

export type QuiverRidType =
  | "analysis"
  | "dashboard"
  | "visual-function"
  | "template"
  | "working-state"
  | "trace";

const RID_RE =
  /^ri\.tellus-quiver\.main\.([a-z][a-z-]*)\.([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

const UUID7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(s: string): boolean {
  return UUID7_RE.test(s);
}

export function newQuiverRid(type: QuiverRidType): string {
  return `ri.tellus-quiver.main.${type}.${uuidv7()}`;
}

export function parseQuiverRid(
  rid: string,
): { type: QuiverRidType; uuid: string } | null {
  const m = RID_RE.exec(rid);
  if (!m) return null;
  return { type: m[1] as QuiverRidType, uuid: m[2] };
}

export function isQuiverRid(rid: string, type?: QuiverRidType): boolean {
  const parsed = parseQuiverRid(rid);
  if (!parsed) return false;
  if (type && parsed.type !== type) return false;
  return true;
}

/** Asserts and narrows; throws TypeError on mismatch. */
export function assertQuiverRid(rid: string, type: QuiverRidType): void {
  if (!isQuiverRid(rid, type)) {
    throw new TypeError(
      `expected RID of type '${type}', got '${rid}'`,
    );
  }
}
