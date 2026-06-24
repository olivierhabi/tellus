/**
 * B10 — Synthesise Link Types from discovered FK constraints.
 *
 * Rules:
 *  - Single-column FK from A.col → B.pk  ⇒  One-to-Many (A is many side, B is one side)
 *      unless A.col is itself unique, in which case One-to-One.
 *  - Two FKs on the same join-table referencing different parents ⇒ Many-to-Many,
 *    join-table is recorded as `join_dataset_rid`.
 */
import type { Knex } from "knex";

export type ForeignKey = {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  isColumnUnique: boolean;
};

export type DiscoveredJoinTable = {
  rid: string;
  table: string;
  fks: ForeignKey[];
};

export type LinkTypeProposal = {
  rid: string;
  source_object_type: string;
  target_object_type: string;
  source_property: string;
  target_property: string;
  cardinality: "one-to-one" | "one-to-many" | "many-to-many";
  join_dataset_rid?: string;
};

function rid(): string {
  return `ri.ontology.main.link.${cryptoRandom()}`;
}

function cryptoRandom(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function proposeLinkTypesFromFKs(
  fks: ForeignKey[],
  tableToObjectType: Record<string, string>,
  tableToPropertyMap: Record<string, Record<string, string>>,
): LinkTypeProposal[] {
  const proposals: LinkTypeProposal[] = [];
  const byTable = new Map<string, ForeignKey[]>();
  for (const fk of fks) {
    const arr = byTable.get(fk.table) ?? [];
    arr.push(fk);
    byTable.set(fk.table, arr);
  }
  for (const [table, group] of byTable) {
    if (group.length === 2 && allFkToDifferentParents(group)) {
      const [a, b] = group;
      const aType = tableToObjectType[a.refTable];
      const bType = tableToObjectType[b.refTable];
      if (!aType || !bType) continue;
      proposals.push({
        rid: rid(),
        source_object_type: aType,
        target_object_type: bType,
        source_property: tableToPropertyMap[a.refTable]?.[a.refColumn] ?? a.refColumn,
        target_property: tableToPropertyMap[b.refTable]?.[b.refColumn] ?? b.refColumn,
        cardinality: "many-to-many",
        join_dataset_rid: table,
      });
      continue;
    }
    for (const fk of group) {
      const srcType = tableToObjectType[fk.table];
      const dstType = tableToObjectType[fk.refTable];
      if (!srcType || !dstType) continue;
      proposals.push({
        rid: rid(),
        source_object_type: srcType,
        target_object_type: dstType,
        source_property: tableToPropertyMap[fk.table]?.[fk.column] ?? fk.column,
        target_property: tableToPropertyMap[fk.refTable]?.[fk.refColumn] ?? fk.refColumn,
        cardinality: fk.isColumnUnique ? "one-to-one" : "one-to-many",
      });
    }
  }
  return proposals;
}

function allFkToDifferentParents(g: ForeignKey[]): boolean {
  return g[0].refTable !== g[1].refTable;
}
