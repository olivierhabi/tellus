/**
 * B10 — FK -> Link Type detector.
 * Consumes a B3 connector discovery snapshot and produces LinkTypeSpecs
 * derived from foreign-key constraints. Cardinality inferred from unique
 * constraints on FK source columns.
 */
import { randomUUID } from "node:crypto";
import type { LinkTypeSpec } from "./contracts";

export type DiscoveredForeignKey = {
  source_table: string;
  source_columns: string[];
  source_columns_unique: boolean;
  target_table: string;
  target_columns: string[];
};

export type BindingLookup = (datasetTable: string) => {
  object_type_rid: string;
  pk_property: string;
} | null;

export function deriveLinkTypes(
  fks: DiscoveredForeignKey[],
  lookup: BindingLookup,
): LinkTypeSpec[] {
  const out: LinkTypeSpec[] = [];
  for (const fk of fks) {
    const src = lookup(fk.source_table);
    const tgt = lookup(fk.target_table);
    if (!src || !tgt) continue;
    if (fk.source_columns.length !== 1 || fk.target_columns.length !== 1) continue;
    const cardinality: LinkTypeSpec["cardinality"] = fk.source_columns_unique ? "1:1" : "N:1";
    out.push({
      rid: `ri.ontology.main.linktype.${randomUUID()}`,
      source_object_type_rid: src.object_type_rid,
      target_object_type_rid: tgt.object_type_rid,
      source_property: fk.source_columns[0],
      target_property: tgt.pk_property,
      cardinality,
      derived_from_fk: true,
    });
  }
  return out;
}
