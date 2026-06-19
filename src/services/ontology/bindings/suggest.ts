/**
 * B10 — Property inference (v1 rules).
 *
 * - Primary key: prefers explicit PK column from discovery; else 'id' or '*_id' single-column unique.
 * - Title property: first text column matching /name|title|label/i; fallback to first text column.
 * - Property name: snake_case → camelCase, ensure unique.
 * - Type: mapped via existing pg→property type table (B3 type-mapping).
 * - Indexed: PK + columns flagged unique by discovery.
 */
import { mapPgTypeToProperty } from "../../connectivity/connectors/postgresql/type-mapping";

export type DiscoveredColumn = {
  name: string;
  pgType: string;
  isPrimaryKey: boolean;
  isUnique: boolean;
  nullable: boolean;
};

export type SuggestionResult = {
  proposedPropertyMap: Record<string, string>;
  pkProperty: string | null;
  titleProperty: string | null;
  properties: Array<{
    sourceColumn: string;
    name: string;
    type: string;
    required: boolean;
    indexed: boolean;
  }>;
  warnings: string[];
};

function toCamel(s: string): string {
  return s.toLowerCase().replace(/_+([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

function dedupe(name: string, taken: Set<string>): string {
  let n = name;
  let i = 1;
  while (taken.has(n)) n = `${name}${++i}`;
  taken.add(n);
  return n;
}

export function suggestPropertyMap(cols: DiscoveredColumn[]): SuggestionResult {
  const taken = new Set<string>();
  const properties: SuggestionResult["properties"] = [];
  const propertyMap: Record<string, string> = {};
  const warnings: string[] = [];

  let pkProperty: string | null = null;
  let pkCol = cols.find((c) => c.isPrimaryKey);
  if (!pkCol) {
    pkCol = cols.find((c) => c.isUnique && (c.name === "id" || /_id$/.test(c.name)));
    if (pkCol) warnings.push(`inferred PK from unique column ${pkCol.name}`);
  }

  let titleProperty: string | null = null;
  const titleCol =
    cols.find((c) => /^(name|title|label)$/i.test(c.name)) ??
    cols.find((c) => /(name|title|label)/i.test(c.name)) ??
    cols.find((c) => /text|char/i.test(c.pgType));

  for (const c of cols) {
    const name = dedupe(toCamel(c.name), taken);
    const type = mapPgTypeToProperty(c.pgType);
    const indexed = c.isPrimaryKey || c.isUnique;
    properties.push({
      sourceColumn: c.name,
      name,
      type,
      required: !c.nullable,
      indexed,
    });
    propertyMap[c.name] = name;
    if (pkCol && c.name === pkCol.name) pkProperty = name;
    if (titleCol && c.name === titleCol.name) titleProperty = name;
  }

  if (!pkProperty) warnings.push("no primary key candidate detected");
  return { proposedPropertyMap: propertyMap, pkProperty, titleProperty, properties, warnings };
}
