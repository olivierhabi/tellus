// ---------------------------------------------------------------------------
// src/services/security/cellMarkingService.ts
//
// FOUNDRY-GAPS §8 — cell-level security markings (migration 102).
//
// A "cell" is a single (object instance, property) intersection. Unlike a
// column marking (property.marking_required — applies to that property on EVERY
// row), a cell marking applies to ONE property of ONE object. At read time we
// redact the property value to `null` when the caller does not hold a superset
// of the cell's markings.
//
// The redaction predicate is intentionally the SAME AND-composition used at the
// row level (`searchAround/markingFilter.userSees`): a caller sees the cell iff
// EVERY marking on the cell is in the caller's granted set. Getting this wrong
// (using intersection instead of superset) leaks data — see the PB-B7 note on
// markingUnion — so the predicate lives in one pure, exhaustively-tested place.
//
// Read paths call this AFTER column-level stripping; a `markingBypass`
// principal (superadmin / system) skips redaction entirely.
// ---------------------------------------------------------------------------

import { query as defaultQuery } from "../../db";
import { userHasAllMarkings } from "../markingUnion";

export type QueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: any[]; rowCount: number | null }>;

/** propertyApiName → markings the caller must ALL hold to see this cell. */
export type CellMarkingMap = Record<string, string[]>;

/** primaryKey → CellMarkingMap. */
export type ObjectCellMarkings = Record<string, CellMarkingMap>;

export interface RedactionOptions {
  /** The caller's granted markings. */
  userMarkings: string[];
  /** Superadmin / system principals see every cell unredacted. */
  markingBypass?: boolean;
  /** Value written in place of a hidden cell. Default `null`. */
  redactWith?: unknown;
}

/**
 * Redact, IN PLACE, every property of `properties` whose cell marking the
 * caller does not satisfy. Returns the list of redacted property names (for
 * audit / a `__redactedCells` hint on the response).
 *
 * Pure given its inputs — no IO. `markingBypass` short-circuits to "redact
 * nothing". A cell with an empty marking set is visible to everyone.
 */
export function redactCells(
  properties: Record<string, unknown>,
  cellMarkings: CellMarkingMap,
  opts: RedactionOptions,
): string[] {
  if (opts.markingBypass) return [];
  const redactWith = "redactWith" in opts ? opts.redactWith : null;
  const granted = opts.userMarkings ?? [];
  const redacted: string[] = [];
  for (const [property, required] of Object.entries(cellMarkings)) {
    if (!required || required.length === 0) continue; // tombstone: visible
    // userHasAllMarkings(required, possessed): true iff granted ⊇ required.
    if (userHasAllMarkings(required, granted)) continue; // caller satisfies it
    if (!(property in properties)) continue; // already stripped at column level
    properties[property] = redactWith;
    redacted.push(property);
  }
  return redacted;
}

export class CellMarkingService {
  constructor(private readonly query: QueryFn = defaultQuery) {}

  /** Cell markings for a single object: { propertyApiName: markings[] }. */
  async getForObject(objectTypeApiName: string, primaryKey: string): Promise<CellMarkingMap> {
    const r = await this.query(
      `SELECT property_api_name, markings
         FROM object_cell_marking
        WHERE object_type_api_name = $1 AND primary_key = $2`,
      [objectTypeApiName, primaryKey],
    );
    const out: CellMarkingMap = {};
    for (const row of r.rows) out[row.property_api_name] = (row.markings as string[]) ?? [];
    return out;
  }

  /** Cell markings for many objects at once (search/list): { pk: { prop: markings[] } }. */
  async getForObjects(
    objectTypeApiName: string,
    primaryKeys: string[],
  ): Promise<ObjectCellMarkings> {
    if (primaryKeys.length === 0) return {};
    const r = await this.query(
      `SELECT primary_key, property_api_name, markings
         FROM object_cell_marking
        WHERE object_type_api_name = $1 AND primary_key = ANY($2)`,
      [objectTypeApiName, primaryKeys],
    );
    const out: ObjectCellMarkings = {};
    for (const row of r.rows) {
      const pk = row.primary_key as string;
      (out[pk] ??= {})[row.property_api_name as string] = (row.markings as string[]) ?? [];
    }
    return out;
  }

  /**
   * Set (upsert) a cell marking. An empty `markings` array tombstones the cell
   * (visible to everyone) rather than deleting the row, so the audit of "this
   * cell was once marked" survives.
   */
  async set(input: {
    objectTypeApiName: string;
    primaryKey: string;
    propertyApiName: string;
    markings: string[];
    ontologyId?: string | null;
    setBy?: string;
  }): Promise<void> {
    await this.query(
      `INSERT INTO object_cell_marking
         (object_type_api_name, primary_key, property_api_name, markings, ontology_id, set_by, set_at)
       VALUES ($1,$2,$3,$4::text[],$5,$6, now())
       ON CONFLICT (object_type_api_name, primary_key, property_api_name)
       DO UPDATE SET markings = EXCLUDED.markings,
                     ontology_id = EXCLUDED.ontology_id,
                     set_by = EXCLUDED.set_by,
                     set_at = now()`,
      [
        input.objectTypeApiName,
        input.primaryKey,
        input.propertyApiName,
        input.markings ?? [],
        input.ontologyId ?? null,
        input.setBy ?? "system",
      ],
    );
  }
}

export default CellMarkingService;
