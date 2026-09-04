// ---------------------------------------------------------------------------
// Link Resolver Service (Thursday Enhanced)
//
// Resolves linked objects for a given primary key across all four
// cardinalities by querying OpenSearch indices. Supports FK-based links
// and CSV join table-based M2M links. Includes self-referential link
// support, multi-hop traversal, link analysis, and Search Around.
// ---------------------------------------------------------------------------

import { client, injectSecurityFilter } from "./opensearch/client";
import { getIndexName } from "./opensearch/indexLifecycleManager";
import { query } from "../db";
import { appError } from "../utils/appError";
import type { LinkTypeRow, Cardinality } from "../models/linkType";
import { incCounter, observeHistogram } from "./funnel/metrics";
import { buildSortClause, translateFilter } from "./queryTranslator";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  pageSize?: number;
  pageToken?: string;
  targetFilter?: Record<string, unknown>;
  select?: string[];
  orderBy?: string;
  orderDirection?: "asc" | "desc";
  excludeSelf?: boolean; // for self-referential links
}

export interface ResolveResult {
  linkedObjects: Array<Record<string, unknown>>;
  totalCount: number;
  nextPageToken: string | null;
}

export interface LinkCountResult {
  linkTypeApiName: string;
  direction: "forward" | "reverse";
  count: number;
}

export interface SearchAroundOptions {
  sourceFilter?: Record<string, unknown>;
  /** Canonical ontology-search where DSL. Prefer this for Workshop linked
   * filters; `sourceFilter` remains for legacy flat equality maps. */
  sourceWhere?: Record<string, unknown>;
  targetFilter?: Record<string, unknown>;
  pageSize?: number;
  pageToken?: string;
  direction?: "forward" | "reverse";
  /** Server-side ordering of the linked (target-side) objects. Mirrors
   *  the regular `/search` route's `orderBy`; resolved against the
   *  resolve-side object type via `buildSortClause`. */
  orderBy?: Array<{ field: string; direction: string }>;
  /**
   * Injected edge-resolution seam (serving-store cutover): when set, the
   * M2M branch calls this instead of parsing the CSV join table. Query
   * shape, filters, pagination and security of the surrounding function
   * are unchanged — only the edge PK lookup is delegated.
   */
  edgeResolver?: (sourcePKs: string[], direction: "forward" | "reverse") => Promise<string[]>;
}

export interface LinkAnalysis {
  linkTypeApiName: string;
  sourceObjectType: string;
  targetObjectType: string;
  cardinality: string;
  totalSourceObjects: number;
  totalTargetObjects: number;
  totalLinkCount: number;
  totalLinkCountExact?: number;
  totalLinkCountMethod?: "exact" | "approximate";
  /**
   * Populated foreign keys whose value does NOT match any indexed target
   * object's primary key. These are edges that would inflate a naive
   * "populated FK" count but never resolve at traversal time. Foundry
   * semantics: link analysis counts resolved edges against indexed
   * target objects, not merely populated foreign keys; dangling edges
   * are reported separately. Invariant: `totalLinkCount > 0` implies
   * `totalTargetObjects > 0` (a resolved edge requires a target).
   */
  danglingEdges: number;
  danglingEdgesExact?: number;
  sourcesWithNoLinks: number;
  sourcesWithNoLinksEstimate?: number;
  targetsWithNoLinks: number;
  distribution: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p90: number;
    p95?: number;
    p99: number;
    p99_9?: number;
  };
  computationMethod?: "composite_agg" | "iceberg_scan" | "sampling";
  sampledFraction?: number;
}

export type AnalysisPrecision = "exact" | "sampled" | "fast";

export interface CardinalityValidation {
  canMigrate: boolean;
  warnings: string[];
  errors: string[];
  currentCardinality: string;
  targetCardinality: string;
}

export interface FKValidationResult {
  valid: boolean;
  warnings: string[];
  orphanedReferences: Array<{ property: string; value: string; targetType: string }>;
}

export interface JoinTableValidation {
  valid: boolean;
  totalRows: number;
  uniqueSourceKeys: number;
  uniqueTargetKeys: number;
  orphanedSourceKeys: string[];
  orphanedTargetKeys: string[];
  duplicateRows: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function termField(field: string): string {
  if (field.startsWith("__")) return field;
  if (field.endsWith(".keyword")) return field;
  return `${field}.keyword`;
}

function buildFilterClauses(
  filter: Record<string, unknown> | undefined
): Array<Record<string, unknown>> {
  if (!filter || Object.keys(filter).length === 0) return [];
  const clauses: Array<Record<string, unknown>> = [];
  for (const [field, value] of Object.entries(filter)) {
    clauses.push({ term: { [termField(field)]: value } });
  }
  return clauses;
}

async function getPropertyApiName(propertyId: string): Promise<string> {
  const result = await query(
    "SELECT api_name FROM property WHERE property_id = $1",
    [propertyId]
  );
  if (result.rows.length === 0) {
    throw appError("PROPERTY_NOT_FOUND", `Property with ID '${propertyId}' not found.`);
  }
  return result.rows[0].api_name;
}

async function getObjectTypeApiName(objectTypeId: string): Promise<string> {
  const result = await query(
    "SELECT api_name FROM object_type WHERE object_type_id = $1",
    [objectTypeId]
  );
  if (result.rows.length === 0) {
    throw appError("OBJECT_TYPE_NOT_FOUND", `Object type with ID '${objectTypeId}' not found.`);
  }
  return result.rows[0].api_name;
}

async function searchIndex(
  indexName: string,
  musts: Array<Record<string, unknown>>,
  from: number,
  size: number,
  sort: Array<Record<string, unknown>> | undefined,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<{ hits: Array<Record<string, unknown>>; total: number }> {
  const body: Record<string, unknown> = {
    from,
    size,
    // Accurate totals beyond OpenSearch's default 10k cap, so the
    // caller's `totalCount` (e.g. a link-group badge) is exact rather
    // than clamped. Mirrors the regular `/search` executor.
    track_total_hits: true,
    query: musts.length === 1 ? musts[0] : { bool: { must: musts } },
  };
  if (sort && sort.length > 0) {
    body.sort = sort;
  }

  // Inject mandatory security filter (§Task 28) + F-P3-13 branch filter.
  // branchId is a REQUIRED parameter; callers must consciously pass `null`
  // for intentional cross-branch reads (admin / indexer paths).
  const finalBody = injectSecurityFilter(body, securityFilter, branchId);

  try {
    const { body: resp } = await client.search({ index: indexName, body: finalBody });
    const hitsObj = (resp as any).hits;
    const total = typeof hitsObj.total === "object" ? hitsObj.total.value : hitsObj.total;
    const hits = (hitsObj.hits as any[]).map((h: any) => h._source as Record<string, unknown>);
    return { hits, total };
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.meta?.statusCode === 404) {
      return { hits: [], total: 0 };
    }
    throw err;
  }
}

async function countIndex(
  indexName: string,
  queryBody: Record<string, unknown>,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<number> {
  try {
    const countBody = injectSecurityFilter({ query: queryBody }, securityFilter, branchId);
    const { body: resp } = await client.count({ index: indexName, body: countBody });
    return (resp as any).count ?? 0;
  } catch (err: any) {
    if (err?.statusCode === 404 || err?.meta?.statusCode === 404) {
      return 0;
    }
    throw err;
  }
}

async function getDocByPK(
  indexName: string,
  pk: string,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<Record<string, unknown> | null> {
  if (securityFilter || branchId !== null) {
    // Use search so OpenSearch enforces the security filter + branch filter.
    const { hits } = await searchIndex(
      indexName, [{ term: { __pk: pk } }], 0, 1, undefined, securityFilter, branchId
    );
    return hits.length > 0 ? hits[0] : null;
  }
  try {
    const { body } = await client.get({ index: indexName, id: pk });
    return (body as any)._source as Record<string, unknown>;
  } catch {
    return null;
  }
}

function decodeToken(token: string | undefined): number {
  if (!token) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString());
    return typeof decoded.offset === "number" ? decoded.offset : 0;
  } catch {
    return 0;
  }
}

function encodeToken(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64");
}

// ---------------------------------------------------------------------------
// CSV Join Table helpers
// ---------------------------------------------------------------------------

function parseJoinTableCSV(filePath: string): Array<{ source: string; target: string }> {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  if (lines.length < 2) return []; // need header + at least 1 row

  const rows: Array<{ source: string; target: string }> = [];
  // First line is header
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    if (cols.length >= 2 && cols[0] && cols[1]) {
      rows.push({ source: cols[0], target: cols[1] });
    }
  }
  return rows;
}

/**
 * Legacy M2M CSV edge resolution — extracted so the serving-store
 * shadow-compare path uses the IDENTICAL code the production route used
 * pre-cutover (visible for shadow tests; deprecated for new code).
 */
export function resolveLegacyCsvM2mPks(
  linkType: LinkTypeRow,
  sourcePKs: string[],
  direction: "forward" | "reverse",
): string[] {
  const out = new Set<string>();
  if (!linkType.join_table_file_path) return [];
  const rows = parseJoinTableCSV(linkType.join_table_file_path);
  for (const pk of sourcePKs) {
    if (direction === "forward") {
      rows.filter((r) => r.source === pk).forEach((r) => out.add(r.target));
    } else {
      rows.filter((r) => r.target === pk).forEach((r) => out.add(r.source));
    }
  }
  return [...out];
}

function getTargetPKsFromJoinTable(filePath: string, sourcePK: string): string[] {
  const rows = parseJoinTableCSV(filePath);
  return rows.filter((r) => r.source === sourcePK).map((r) => r.target);
}

function getSourcePKsFromJoinTable(filePath: string, targetPK: string): string[] {
  const rows = parseJoinTableCSV(filePath);
  return rows.filter((r) => r.target === targetPK).map((r) => r.source);
}

// ---------------------------------------------------------------------------
// Core resolution
// ---------------------------------------------------------------------------

export async function resolveLinks(
  linkType: LinkTypeRow,
  objectPK: string,
  direction: "forward" | "reverse",
  options: ResolveOptions = {},
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<ResolveResult> {
  const pageSize = Math.min(options.pageSize ?? 100, 1000);
  const from = decodeToken(options.pageToken);
  const filterClauses = buildFilterClauses(options.targetFilter);

  const sourceOtApiName = await getObjectTypeApiName(linkType.source_object_type);
  const targetOtApiName = await getObjectTypeApiName(linkType.target_object_type);

  const cardinality = linkType.cardinality as Cardinality;
  const isSelfRef = linkType.source_object_type === linkType.target_object_type;

  // For self-referential links, add self-exclusion filter
  if (isSelfRef && options.excludeSelf !== false) {
    filterClauses.push({ bool: { must_not: [{ term: { __pk: objectPK } }] } });
  }

  if (direction === "forward") {
    return resolveForward(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, from, pageSize, filterClauses, securityFilter, branchId);
  } else {
    return resolveReverse(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, from, pageSize, filterClauses, securityFilter, branchId);
  }
}

async function resolveForward(
  linkType: LinkTypeRow,
  sourcePK: string,
  sourceOtApiName: string,
  targetOtApiName: string,
  cardinality: Cardinality,
  from: number,
  size: number,
  filterClauses: Array<Record<string, unknown>>,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<ResolveResult> {
  const targetIndex = getIndexName(targetOtApiName);
  const sourceIndex = getIndexName(sourceOtApiName);

  switch (cardinality) {
    case "ONE_TO_MANY": {
      const targetPropName = linkType.target_property_id
        ? await getPropertyApiName(linkType.target_property_id)
        : null;
      if (!targetPropName) {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      }
      const musts: Array<Record<string, unknown>> = [
        { term: { [termField(targetPropName)]: sourcePK } },
        ...filterClauses,
      ];
      const { hits, total } = await searchIndex(targetIndex, musts, from, size, undefined, securityFilter, branchId);
      const nextPageToken = from + size < total ? encodeToken(from + size) : null;
      return { linkedObjects: hits, totalCount: total, nextPageToken };
    }

    case "MANY_TO_ONE": {
      const sourcePropName = linkType.source_property_id
        ? await getPropertyApiName(linkType.source_property_id)
        : null;
      if (!sourcePropName) {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      }
      const sourceDoc = await getDocByPK(sourceIndex, sourcePK, securityFilter, branchId);
      if (!sourceDoc) {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      }
      const fkValue = sourceDoc[sourcePropName];
      if (fkValue === null || fkValue === undefined || fkValue === "") {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      }
      const musts: Array<Record<string, unknown>> = [
        { term: { __pk: String(fkValue) } },
        ...filterClauses,
      ];
      const { hits, total } = await searchIndex(targetIndex, musts, from, size, undefined, securityFilter, branchId);
      return { linkedObjects: hits, totalCount: total, nextPageToken: null };
    }

    case "ONE_TO_ONE": {
      if (linkType.source_property_id) {
        const sourcePropName = await getPropertyApiName(linkType.source_property_id);
        const sourceDoc = await getDocByPK(sourceIndex, sourcePK, securityFilter, branchId);
        if (!sourceDoc) return { linkedObjects: [], totalCount: 0, nextPageToken: null };
        const fkValue = sourceDoc[sourcePropName];
        if (fkValue === null || fkValue === undefined || fkValue === "") {
          return { linkedObjects: [], totalCount: 0, nextPageToken: null };
        }
        const musts: Array<Record<string, unknown>> = [
          { term: { __pk: String(fkValue) } },
          ...filterClauses,
        ];
        const { hits, total } = await searchIndex(targetIndex, musts, 0, 1, undefined, securityFilter, branchId);
        if (hits.length > 1) {
          console.warn(`[ONE_TO_ONE_VIOLATION] Link '${linkType.api_name}': source ${sourcePK} has ${total} targets`);
        }
        return { linkedObjects: hits, totalCount: total, nextPageToken: null };
      }
      if (linkType.target_property_id) {
        const targetPropName = await getPropertyApiName(linkType.target_property_id);
        const musts: Array<Record<string, unknown>> = [
          { term: { [termField(targetPropName)]: sourcePK } },
          ...filterClauses,
        ];
        const { hits, total } = await searchIndex(targetIndex, musts, 0, 1, undefined, securityFilter, branchId);
        if (total > 1) {
          console.warn(`[ONE_TO_ONE_VIOLATION] Link '${linkType.api_name}': source ${sourcePK} has ${total} targets`);
        }
        return { linkedObjects: hits, totalCount: Math.min(total, 1), nextPageToken: null };
      }
      return { linkedObjects: [], totalCount: 0, nextPageToken: null };
    }

    case "MANY_TO_MANY": {
      // M2M via join table CSV
      if (linkType.join_table_file_path) {
        const targetPKs = getTargetPKsFromJoinTable(linkType.join_table_file_path, sourcePK);
        if (targetPKs.length === 0) {
          return { linkedObjects: [], totalCount: 0, nextPageToken: null };
        }
        const cappedPKs = targetPKs.slice(0, 100000);
        const musts: Array<Record<string, unknown>> = [
          { terms: { __pk: cappedPKs } },
          ...filterClauses,
        ];
        const { hits, total } = await searchIndex(targetIndex, musts, from, size, undefined, securityFilter, branchId);
        const nextPageToken = from + size < total ? encodeToken(from + size) : null;
        return { linkedObjects: hits, totalCount: total, nextPageToken };
      }
      // M2M via FK properties (fallback)
      const targetPropName = linkType.target_property_id
        ? await getPropertyApiName(linkType.target_property_id)
        : null;
      if (!targetPropName) {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      }
      const musts: Array<Record<string, unknown>> = [
        { term: { [termField(targetPropName)]: sourcePK } },
        ...filterClauses,
      ];
      const { hits, total } = await searchIndex(targetIndex, musts, from, size, undefined, securityFilter, branchId);
      const nextPageToken = from + size < total ? encodeToken(from + size) : null;
      return { linkedObjects: hits, totalCount: total, nextPageToken };
    }

    default:
      return { linkedObjects: [], totalCount: 0, nextPageToken: null };
  }
}

async function resolveReverse(
  linkType: LinkTypeRow,
  targetPK: string,
  sourceOtApiName: string,
  targetOtApiName: string,
  cardinality: Cardinality,
  from: number,
  size: number,
  filterClauses: Array<Record<string, unknown>>,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<ResolveResult> {
  const sourceIndex = getIndexName(sourceOtApiName);
  const targetIndex = getIndexName(targetOtApiName);

  switch (cardinality) {
    case "ONE_TO_MANY": {
      const targetPropName = linkType.target_property_id
        ? await getPropertyApiName(linkType.target_property_id)
        : null;
      if (!targetPropName) {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      }
      const targetDoc = await getDocByPK(targetIndex, targetPK, securityFilter, branchId);
      if (!targetDoc) return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      const fkValue = targetDoc[targetPropName];
      if (fkValue === null || fkValue === undefined || fkValue === "") {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      }
      const musts: Array<Record<string, unknown>> = [
        { term: { __pk: String(fkValue) } },
        ...filterClauses,
      ];
      const { hits, total } = await searchIndex(sourceIndex, musts, 0, 1, undefined, securityFilter, branchId);
      return { linkedObjects: hits, totalCount: total, nextPageToken: null };
    }

    case "MANY_TO_ONE": {
      const sourcePropName = linkType.source_property_id
        ? await getPropertyApiName(linkType.source_property_id)
        : null;
      if (!sourcePropName) {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      }
      const musts: Array<Record<string, unknown>> = [
        { term: { [termField(sourcePropName)]: targetPK } },
        ...filterClauses,
      ];
      const { hits, total } = await searchIndex(sourceIndex, musts, from, size, undefined, securityFilter, branchId);
      const nextPageToken = from + size < total ? encodeToken(from + size) : null;
      return { linkedObjects: hits, totalCount: total, nextPageToken };
    }

    case "ONE_TO_ONE": {
      if (linkType.source_property_id) {
        const sourcePropName = await getPropertyApiName(linkType.source_property_id);
        // fix(A5): reverse ONE_TO_ONE resolves the linked SOURCE object by
        // searching the SOURCE FK property for the TARGET pk. `term` on a
        // `.keyword` subfield fails when the OS mapping's FK property is
        // text-analysed (no .keyword multi-field) — the per-application-query
        // dash-separated pk is tokenised and the term query token ≠ indexed
        // token. Add a `match_phrase` should-clause (matches text-analysed
        // fields) so reverse reads work across both mappings.
        const musts: Array<Record<string, unknown>> = [
          {
            bool: {
              minimum_should_match: 1,
              should: [
                { term: { [termField(sourcePropName)]: targetPK } },
                { match_phrase: { [sourcePropName]: targetPK } },
              ],
            },
          },
          ...filterClauses,
        ];
        const { hits, total } = await searchIndex(sourceIndex, musts, 0, 1, undefined, securityFilter, branchId);
        return { linkedObjects: hits, totalCount: total, nextPageToken: null };
      }
      if (linkType.target_property_id) {
        const targetPropName = await getPropertyApiName(linkType.target_property_id);
        const targetDoc = await getDocByPK(targetIndex, targetPK, securityFilter, branchId);
        if (!targetDoc) return { linkedObjects: [], totalCount: 0, nextPageToken: null };
        const fkValue = targetDoc[targetPropName];
        if (fkValue === null || fkValue === undefined || fkValue === "") {
          return { linkedObjects: [], totalCount: 0, nextPageToken: null };
        }
        const musts: Array<Record<string, unknown>> = [
          { term: { __pk: String(fkValue) } },
          ...filterClauses,
        ];
        const { hits, total } = await searchIndex(sourceIndex, musts, 0, 1, undefined, securityFilter, branchId);
        return { linkedObjects: hits, totalCount: total, nextPageToken: null };
      }
      return { linkedObjects: [], totalCount: 0, nextPageToken: null };
    }

    case "MANY_TO_MANY": {
      // M2M via join table CSV (reversed column lookup)
      if (linkType.join_table_file_path) {
        const sourcePKs = getSourcePKsFromJoinTable(linkType.join_table_file_path, targetPK);
        if (sourcePKs.length === 0) {
          return { linkedObjects: [], totalCount: 0, nextPageToken: null };
        }
        const cappedPKs = sourcePKs.slice(0, 100000);
        const musts: Array<Record<string, unknown>> = [
          { terms: { __pk: cappedPKs } },
          ...filterClauses,
        ];
        const { hits, total } = await searchIndex(sourceIndex, musts, from, size, undefined, securityFilter, branchId);
        const nextPageToken = from + size < total ? encodeToken(from + size) : null;
        return { linkedObjects: hits, totalCount: total, nextPageToken };
      }
      // M2M via FK properties (fallback, reversed)
      const sourcePropName = linkType.source_property_id
        ? await getPropertyApiName(linkType.source_property_id)
        : null;
      if (!sourcePropName) {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      }
      const musts: Array<Record<string, unknown>> = [
        { term: { [termField(sourcePropName)]: targetPK } },
        ...filterClauses,
      ];
      const { hits, total } = await searchIndex(sourceIndex, musts, from, size, undefined, securityFilter, branchId);
      const nextPageToken = from + size < total ? encodeToken(from + size) : null;
      return { linkedObjects: hits, totalCount: total, nextPageToken };
    }

    default:
      return { linkedObjects: [], totalCount: 0, nextPageToken: null };
  }
}

// ---------------------------------------------------------------------------
// Count
// ---------------------------------------------------------------------------

export async function countLinks(
  linkType: LinkTypeRow,
  objectPK: string,
  direction: "forward" | "reverse",
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<number> {
  const sourceOtApiName = await getObjectTypeApiName(linkType.source_object_type);
  const targetOtApiName = await getObjectTypeApiName(linkType.target_object_type);
  const cardinality = linkType.cardinality as Cardinality;

  if (direction === "forward") {
    switch (cardinality) {
      case "ONE_TO_MANY": {
        const targetPropName = linkType.target_property_id
          ? await getPropertyApiName(linkType.target_property_id) : null;
        if (!targetPropName) return 0;
        return countIndex(getIndexName(targetOtApiName), { term: { [termField(targetPropName)]: objectPK } }, securityFilter, branchId);
      }
      case "MANY_TO_ONE": {
        const sourcePropName = linkType.source_property_id
          ? await getPropertyApiName(linkType.source_property_id) : null;
        if (!sourcePropName) return 0;
        const sourceDoc = await getDocByPK(getIndexName(sourceOtApiName), objectPK, securityFilter, branchId);
        if (!sourceDoc) return 0;
        const fkVal = sourceDoc[sourcePropName];
        if (fkVal === null || fkVal === undefined || fkVal === "") return 0;
        return countIndex(getIndexName(targetOtApiName), { term: { __pk: String(fkVal) } }, securityFilter, branchId);
      }
      case "ONE_TO_ONE": {
        const res = await resolveForward(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, 0, 1, [], securityFilter, branchId);
        return res.totalCount;
      }
      case "MANY_TO_MANY": {
        if (linkType.join_table_file_path) {
          // Stage-4 (indexed security): the CSV mask-direct count was a
          // leak (no marking checks). Never count by CSV alone — honour
          // the marking filter via the doc-side countIndex: target PKs from
          // the join file are only the candidate list; countIndex applies
          // `_security` correctly.
          const targetPKs = getTargetPKsFromJoinTable(linkType.join_table_file_path, objectPK);
          if (targetPKs.length === 0) return 0;
          return countIndex(getIndexName(targetOtApiName), { terms: { __pk: targetPKs } }, securityFilter, branchId);
        }
        const targetPropName = linkType.target_property_id
          ? await getPropertyApiName(linkType.target_property_id) : null;
        if (!targetPropName) return 0;
        return countIndex(getIndexName(targetOtApiName), { term: { [termField(targetPropName)]: objectPK } }, securityFilter, branchId);
      }
      default: return 0;
    }
  } else {
    switch (cardinality) {
      case "ONE_TO_MANY": {
        const res = await resolveReverse(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, 0, 1, [], securityFilter, branchId);
        return res.totalCount;
      }
      case "MANY_TO_ONE": {
        const sourcePropName = linkType.source_property_id
          ? await getPropertyApiName(linkType.source_property_id) : null;
        if (!sourcePropName) return 0;
        return countIndex(getIndexName(sourceOtApiName), { term: { [termField(sourcePropName)]: objectPK } }, securityFilter, branchId);
      }
      case "ONE_TO_ONE": {
        const res = await resolveReverse(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, 0, 1, [], securityFilter, branchId);
        return res.totalCount;
      }
      case "MANY_TO_MANY": {
        if (linkType.join_table_file_path) {
          // Same Stage-4 closing: reverse count must also pass through
          // the marking envelope, never CSV-only.
          const sourcePKs = getSourcePKsFromJoinTable(linkType.join_table_file_path, objectPK);
          if (sourcePKs.length === 0) return 0;
          return countIndex(getIndexName(sourceOtApiName), { terms: { __pk: sourcePKs } }, securityFilter, branchId);
        }
        const sourcePropName = linkType.source_property_id
          ? await getPropertyApiName(linkType.source_property_id) : null;
        if (!sourcePropName) return 0;
        return countIndex(getIndexName(sourceOtApiName), { term: { [termField(sourcePropName)]: objectPK } }, securityFilter, branchId);
      }
      default: return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Bulk Count — counts for all link types of an object
// ---------------------------------------------------------------------------

export async function bulkCountLinks(
  ontologyId: string,
  objectTypeId: string,
  objectPK: string,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<Array<{ linkTypeApiName: string; direction: string; count: number | null; error?: string }>> {
  const { listByObjectType } = await import("../models/linkType");
  const linkTypes = await listByObjectType(ontologyId, objectTypeId);

  const results = await Promise.allSettled(
    linkTypes.map(async (lt) => {
      const count = await countLinks(lt, objectPK, lt.direction, securityFilter, branchId);
      return { linkTypeApiName: lt.api_name, direction: lt.direction, count };
    })
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") {
      return r.value;
    }
    return {
      linkTypeApiName: linkTypes[i].api_name,
      direction: linkTypes[i].direction,
      count: null,
      error: (r.reason as Error).message,
    };
  });
}

// ---------------------------------------------------------------------------
// Search Around
// ---------------------------------------------------------------------------

export async function searchAround(
  linkType: LinkTypeRow,
  direction: "forward" | "reverse",
  options: SearchAroundOptions = {},
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<ResolveResult & { warnings?: string[] }> {
  const sourceOtApiName = await getObjectTypeApiName(linkType.source_object_type);
  const targetOtApiName = await getObjectTypeApiName(linkType.target_object_type);
  const pageSize = Math.min(options.pageSize ?? 100, 1000);
  const from = decodeToken(options.pageToken);
  const warnings: string[] = [];

  // Step 1: Determine which side is the "search from" side
  const searchOtApiName = direction === "forward" ? sourceOtApiName : targetOtApiName;
  const searchIndexName = getIndexName(searchOtApiName);
  const sourceFilterClauses = buildFilterClauses(options.sourceFilter);
  const sourceQuery: Record<string, unknown> = options.sourceWhere
    ? await translateFilter(options.sourceWhere, searchOtApiName)
    : sourceFilterClauses.length > 0
      ? { bool: { must: sourceFilterClauses } }
      : { match_all: {} };

  let sourcePKs: string[] = [];
  const MAX_SOURCE = 100000;
  try {
    const { body: resp } = await client.search({
      index: searchIndexName,
      // F-P3-13: source-side object lookup respects branch isolation.
      body: injectSecurityFilter({ size: MAX_SOURCE, _source: ["__pk"], query: sourceQuery }, securityFilter, branchId),
    });
    const hitsObj = (resp as any).hits;

    const totalHits = typeof hitsObj.total === "object" ? hitsObj.total.value : hitsObj.total;
    sourcePKs = (hitsObj.hits as any[]).map((h: any) => h._source.__pk as string);

    if (totalHits > MAX_SOURCE) {
      warnings.push(`Source filter matched ${totalHits} objects but only first ${MAX_SOURCE} were used.`);
    }
  } catch (srcErr) {
    if (process.env.OSV2_TRACE === "1") {
      console.log(JSON.stringify({ t: "searchAround-src-err", error: (srcErr as Error).message.slice(0, 200) }));
    }
    return { linkedObjects: [], totalCount: 0, nextPageToken: null, warnings };
  }

  if (sourcePKs.length === 0) {
    if (process.env.OSV2_TRACE === "1") {
      console.log(JSON.stringify({ t: "searchAround-src-no-hits" }));
    }
    return { linkedObjects: [], totalCount: 0, nextPageToken: null, warnings };
  }

  // Step 2: Bulk resolve - build a single query for all source PKs
  const cardinality = linkType.cardinality as Cardinality;
  const targetFilterClauses = buildFilterClauses(options.targetFilter);
  const resolveOtApiName = direction === "forward" ? targetOtApiName : sourceOtApiName;
  const resolveIndexName = getIndexName(resolveOtApiName);

  // Server-side ordering of the resolved (linked) objects. Resolved
  // against the resolve-side object type; an invalid field is ignored
  // (with a warning) rather than failing the whole traversal.
  let sortClause: Array<Record<string, unknown>> | undefined;
  if (options.orderBy && options.orderBy.length > 0) {
    try {
      sortClause = await buildSortClause(options.orderBy, resolveOtApiName);
    } catch {
      warnings.push("Ignored invalid orderBy field(s) for searchAround.");
    }
  }

  let fkField: string | null = null;

  // Determine the FK field for the bulk query
  if (cardinality === "ONE_TO_MANY" && direction === "forward") {
    fkField = linkType.target_property_id ? await getPropertyApiName(linkType.target_property_id) : null;
  } else if (cardinality === "MANY_TO_ONE" && direction === "reverse") {
    fkField = linkType.source_property_id ? await getPropertyApiName(linkType.source_property_id) : null;
  } else if (cardinality === "ONE_TO_MANY" && direction === "reverse") {
    // Reverse O2M: each target has FK pointing to source. Collect FK values from targets, then get sources.
    fkField = linkType.target_property_id ? await getPropertyApiName(linkType.target_property_id) : null;
  } else if (cardinality === "MANY_TO_ONE" && direction === "forward") {
    fkField = linkType.source_property_id ? await getPropertyApiName(linkType.source_property_id) : null;
  }

  // For FK-based links, try a single bulk terms query
  if (fkField && (
    (cardinality === "ONE_TO_MANY" && direction === "forward") ||
    (cardinality === "MANY_TO_ONE" && direction === "reverse")
  )) {
    const musts: Array<Record<string, unknown>> = [
      { terms: { [termField(fkField)]: sourcePKs } },
      ...targetFilterClauses,
    ];
    const { hits, total } = await searchIndex(resolveIndexName, musts, from, pageSize, sortClause, securityFilter, branchId);
    const nextPageToken = from + pageSize < total ? encodeToken(from + pageSize) : null;
    return { linkedObjects: hits, totalCount: total, nextPageToken, warnings };
  }

  // For M2M: injected serving-store edge resolver takes precedence over
  // the legacy CSV join table (servingFlags: shadow/indexed modes).
  if (cardinality === "MANY_TO_MANY" && options.edgeResolver) {
    const linked = await options.edgeResolver(sourcePKs, direction);
    if (linked.length === 0) {
      return { linkedObjects: [], totalCount: 0, nextPageToken: null, warnings };
    }
    const musts: Array<Record<string, unknown>> = [
      { terms: { __pk: linked.slice(0, 100000) } },
      ...targetFilterClauses,
    ];
    const { hits, total } = await searchIndex(resolveIndexName, musts, from, pageSize, sortClause, securityFilter, branchId);
    const nextPageToken = from + pageSize < total ? encodeToken(from + pageSize) : null;
    return { linkedObjects: hits, totalCount: total, nextPageToken, warnings };
  }

  // For M2M with join table
  if (cardinality === "MANY_TO_MANY" && linkType.join_table_file_path) {
    const allTargetPKs = resolveLegacyCsvM2mPks(linkType, sourcePKs, direction);
    if (allTargetPKs.length === 0) {
      return { linkedObjects: [], totalCount: 0, nextPageToken: null, warnings };
    }
    const musts: Array<Record<string, unknown>> = [
      { terms: { __pk: allTargetPKs.slice(0, 100000) } },
      ...targetFilterClauses,
    ];
    const { hits, total } = await searchIndex(resolveIndexName, musts, from, pageSize, sortClause, securityFilter, branchId);
    const nextPageToken = from + pageSize < total ? encodeToken(from + pageSize) : null;
    return { linkedObjects: hits, totalCount: total, nextPageToken, warnings };
  }

  // Fallback: resolve each source individually and deduplicate
  const allLinked: Array<Record<string, unknown>> = [];
  const seenPKs = new Set<string>();

  for (const pk of sourcePKs.slice(0, 1000)) {
    const result = await resolveLinks(linkType, pk, direction, {
      pageSize: 1000,
      targetFilter: options.targetFilter,
      excludeSelf: true,
    }, securityFilter, branchId);
    for (const obj of result.linkedObjects) {
      const objPK = String(obj.__pk ?? "");
      if (!seenPKs.has(objPK)) {
        seenPKs.add(objPK);
        allLinked.push(obj);
      }
    }
  }

  const total = allLinked.length;
  const paged = allLinked.slice(from, from + pageSize);
  const nextPageToken = from + pageSize < total ? encodeToken(from + pageSize) : null;

  return { linkedObjects: paged, totalCount: total, nextPageToken, warnings };
}

// ---------------------------------------------------------------------------
// Multi-hop traversal
// ---------------------------------------------------------------------------

export interface MultiHopStep {
  linkTypeApiName: string;
  ontologyId: string;
  direction: "forward" | "reverse";
}

// T-09 — multi-hop tunables.
//   * MULTI_HOP_CONCURRENCY — bounded concurrency for the per-hop fan-out.
//     Pre-T-09 the code awaited each starting-PK sequentially; with N=1000
//     starting PKs that was 1000 round-trips on a hot path. Chunking
//     into Promise.all of 50 cuts that to 20 round-trips while keeping
//     the OpenSearch shard concurrency reasonable.
//   * MAX_INTERMEDIATE — accumulated visited-PK cap across ALL hops,
//     not per-hop. Without an accumulated cap, a 5-hop traversal at the
//     per-hop limit could explode to 500k PKs, OOM the executor, and
//     return a partial result (silently truncated by the per-hop slice).
//     Now exceeded → SEARCH_AROUND_LIMIT_EXCEEDED.
const MULTI_HOP_CONCURRENCY = 50;
const MULTI_HOP_MAX_INTERMEDIATE = 100_000;

function chunked<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// T-09 — Testing seam.
// `resolveMultiHop` calls `resolveLinks` for every PK in the frontier.
// ESM lexical scoping means `vi.spyOn(linkResolver, "resolveLinks")` from a
// test cannot intercept the *internal* call site — only external imports.
// To make the cycle/concurrency contracts (C-150, C-152) testable at the
// unit level without a live OpenSearch instance, internal callers go
// through this indirection object. Production code paths import
// `resolveLinks` directly, so the prod call graph is unchanged.
export const __internals = { resolveLinks };

export async function resolveMultiHop(
  steps: MultiHopStep[],
  startingPKs: string[],
  options: ResolveOptions = {},
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<ResolveResult & { hopsCompleted: number }> {
  if (steps.length > 5) {
    throw appError("VALIDATION_FAILED", "Maximum 5 hops allowed.");
  }
  if (steps.length === 0) {
    throw appError("VALIDATION_FAILED", "At least 1 hop is required.");
  }

  const { getByApiName } = await import("../models/linkType");

  // Accumulated set of every PK we've ever visited. Pre-seeded with
  // startingPKs so a cycle A → B → A cannot revisit A on a later hop
  // (it stays in `visitedPKs` from the start).
  const visitedPKs = new Set<string>(startingPKs);
  // Frontier for the current hop: only the *new* PKs discovered last
  // hop. Pre-T-09 this was every PK from last hop, which traversed
  // duplicates and produced the H-12 N+1 + cycle bug.
  let currentPKs: string[] = [...startingPKs];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const linkType = await getByApiName(step.ontologyId, step.linkTypeApiName);
    if (!linkType) {
      throw appError("LINK_TYPE_NOT_FOUND", `Link type '${step.linkTypeApiName}' not found.`);
    }

    const isLastHop = i === steps.length - 1;
    const newlyDiscovered = new Set<string>();

    // Bounded concurrency: chunk the frontier and Promise.all per chunk.
    // The chunk size is the only place the explorer parallelises against
    // OpenSearch; it is tuned to be high enough to amortise round-trip
    // latency but low enough that one user can't saturate shard threads.
    for (const chunk of chunked(currentPKs, MULTI_HOP_CONCURRENCY)) {
      const results = await Promise.all(
        chunk.map((pk) =>
          __internals.resolveLinks(
            linkType,
            pk,
            step.direction,
            {
              pageSize: isLastHop ? options.pageSize : 1000,
              excludeSelf: true,
            },
            securityFilter,
            branchId,
          ),
        ),
      );
      for (const result of results) {
        for (const obj of result.linkedObjects) {
          const pk = String(obj.__pk ?? "");
          if (!pk) continue;
          if (!visitedPKs.has(pk)) {
            visitedPKs.add(pk);
            newlyDiscovered.add(pk);
          }
        }
      }
      // Accumulated cap check — fail loudly the moment we cross the
      // line. The pre-T-09 silent slice could lose results without
      // any indication to the caller.
      if (visitedPKs.size > MULTI_HOP_MAX_INTERMEDIATE) {
        throw appError(
          "SEARCH_AROUND_LIMIT_EXCEEDED",
          `Accumulated visited PKs (${visitedPKs.size}) exceeded ${MULTI_HOP_MAX_INTERMEDIATE} during hop ${i + 1}/${steps.length}.`,
          { visited: visitedPKs.size, limit: MULTI_HOP_MAX_INTERMEDIATE, hop: i + 1 },
        );
      }
    }

    if (isLastHop) {
      observeHistogram("tellus_search_around_visited_pks", visitedPKs.size);
      observeHistogram("tellus_search_around_hops", i + 1);
      incCounter("tellus_search_around_total", { hops: String(i + 1) });

      const lastHopPKs = [...newlyDiscovered];

      const targetOtId = step.direction === "forward"
        ? linkType.target_object_type
        : linkType.source_object_type;
      const targetOtApiName = await getObjectTypeApiName(targetOtId);
      const targetIndex = getIndexName(targetOtApiName);

      const pageSize = Math.min(options.pageSize ?? 100, 1000);
      const from = decodeToken(options.pageToken);
      const filterClauses = buildFilterClauses(options.targetFilter);

      if (lastHopPKs.length === 0) {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null, hopsCompleted: i + 1 };
      }

      const musts: Array<Record<string, unknown>> = [
        { terms: { __pk: lastHopPKs } },
        ...filterClauses,
      ];
      const { hits, total } = await searchIndex(targetIndex, musts, from, pageSize, undefined, securityFilter, branchId);
      const nextPageToken = from + pageSize < total ? encodeToken(from + pageSize) : null;
      return { linkedObjects: hits, totalCount: total, nextPageToken, hopsCompleted: i + 1 };
    }

    // Frontier for next hop: only the newly-discovered PKs.
    currentPKs = [...newlyDiscovered];
    if (currentPKs.length === 0) {
      observeHistogram("tellus_search_around_visited_pks", visitedPKs.size);
      observeHistogram("tellus_search_around_hops", i + 1);
      return { linkedObjects: [], totalCount: 0, nextPageToken: null, hopsCompleted: i + 1 };
    }
  }

  observeHistogram("tellus_search_around_visited_pks", visitedPKs.size);
  observeHistogram("tellus_search_around_hops", steps.length);
  return { linkedObjects: [], totalCount: 0, nextPageToken: null, hopsCompleted: steps.length };
}

// ---------------------------------------------------------------------------
// Link Analysis
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LT-B10 — Composite aggregation helper for billion-row analytics.
// Pages through `composite` aggregation instead of the broken
// `terms size=10000` truncation used previously.
// ---------------------------------------------------------------------------

async function collectCompositeCounts(
  indexName: string,
  fkField: string,
  maxBuckets: number,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<number[]> {
  const counts: number[] = [];
  let afterKey: Record<string, unknown> | undefined;

  while (counts.length < maxBuckets) {
    const aggBody: Record<string, unknown> = {
      size: 0,
      query: { exists: { field: fkField } },
      aggs: {
        fk_buckets: {
          composite: {
            size: 1000,
            sources: [{ fk: { terms: { field: termField(fkField) } } }],
            ...(afterKey ? { after: afterKey } : {}),
          },
        },
      },
    };
    let resp: any;
    try {
      // F-P3-13: composite aggregation scoped to branch.
      const { body } = await client.search({ index: indexName, body: injectSecurityFilter(aggBody, securityFilter, branchId) });
      resp = body;
    } catch {
      break;
    }
    const agg = resp?.aggregations?.fk_buckets;
    const buckets = (agg?.buckets ?? []) as Array<{ doc_count: number }>;
    if (buckets.length === 0) break;
    for (const b of buckets) counts.push(b.doc_count);
    afterKey = agg?.after_key;
    if (!afterKey) break;
  }
  return counts.sort((a, b) => a - b);
}

/**
 * Composite-aggregation that retains both the bucket KEY and its
 * doc_count (unlike `collectCompositeCounts` which discards the key).
 * Used to compute resolved-vs-dangling edges: the bucket key is a
 * foreign-key value that must be intersected with the target index's
 * `__pk` set.
 */
async function collectCompositeTerms(
  indexName: string,
  field: string,
  maxBuckets: number,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<Array<{ value: string; count: number }>> {
  const out: Array<{ value: string; count: number }> = [];
  let afterKey: Record<string, unknown> | undefined;
  while (out.length < maxBuckets) {
    const aggBody: Record<string, unknown> = {
      size: 0,
      query: { exists: { field } },
      aggs: {
        fk_buckets: {
          composite: {
            size: 1000,
            sources: [{ fk: { terms: { field: termField(field) } } }],
            ...(afterKey ? { after: afterKey } : {}),
          },
        },
      },
    };
    let resp: any;
    try {
      // F-P3-13: composite aggregation scoped to branch.
      const { body } = await client.search({
        index: indexName,
        body: injectSecurityFilter(aggBody, securityFilter, branchId),
      });
      resp = body;
    } catch {
      break;
    }
    const agg = resp?.aggregations?.fk_buckets;
    const buckets = (agg?.buckets ?? []) as Array<{
      key: { fk: string | number };
      doc_count: number;
    }>;
    if (buckets.length === 0) break;
    for (const b of buckets) out.push({ value: String(b.key.fk), count: b.doc_count });
    afterKey = agg?.after_key;
    if (!afterKey) break;
  }
  return out;
}

/**
 * Returns the set of primary-key (`__pk`) values present in an index.
 * Capped at `maxBuckets` distinct keys. A populated FK whose value is
 * absent from this set is a dangling edge (no indexed target to resolve
 * against). When the target index is empty/stale this set is empty and
 * EVERY populated FK is dangling — which is the exact root cause of the
 * historical "links > 0 / targets = 0" contradiction.
 */
async function collectPkSet(
  indexName: string,
  maxBuckets: number,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<Set<string>> {
  const terms = await collectCompositeTerms(indexName, "__pk", maxBuckets, securityFilter, branchId);
  return new Set(terms.map((t) => t.value));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[Math.max(0, idx)];
}

export async function analyzeLinkType(
  linkType: LinkTypeRow,
  opts: { precision?: AnalysisPrecision; maxBuckets?: number } = {},
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<LinkAnalysis> {
  const sourceOtApiName = await getObjectTypeApiName(linkType.source_object_type);
  const targetOtApiName = await getObjectTypeApiName(linkType.target_object_type);
  const sourceIndex = getIndexName(sourceOtApiName);
  const targetIndex = getIndexName(targetOtApiName);

  // Get total counts
  const totalSourceObjects = await countIndex(sourceIndex, { match_all: {} }, securityFilter, branchId);
  const totalTargetObjects = await countIndex(targetIndex, { match_all: {} }, securityFilter, branchId);

  let totalLinkCount = 0;
  let danglingEdges = 0;
  let sourcesWithNoLinks = 0;
  let distribution = { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p99: 0 };

  const cardinality = linkType.cardinality as Cardinality;

  let targetsWithNoLinks = 0;

  if (cardinality === "MANY_TO_MANY" && linkType.join_table_file_path) {
    // For M2M with join table, parse the CSV
    const rows = parseJoinTableCSV(linkType.join_table_file_path);
    totalLinkCount = rows.length;

    const sourceCountMap = new Map<string, number>();
    const targetCountMap = new Map<string, number>();
    for (const row of rows) {
      sourceCountMap.set(row.source, (sourceCountMap.get(row.source) || 0) + 1);
      targetCountMap.set(row.target, (targetCountMap.get(row.target) || 0) + 1);
    }
    const counts = Array.from(sourceCountMap.values()).sort((a, b) => a - b);
    sourcesWithNoLinks = Math.max(0, totalSourceObjects - sourceCountMap.size);
    targetsWithNoLinks = Math.max(0, totalTargetObjects - targetCountMap.size);

    if (counts.length > 0) {
      distribution = computeDistribution(counts);
    }

    // M2M dangling edges: rows whose target (or source) PK is absent
    // from the indexed object sets. A row pointing at a non-indexed
    // target never resolves at traversal time — report it as dangling
    // rather than inflating totalLinkCount.
    const precisionM2M: AnalysisPrecision = opts.precision ?? "sampled";
    const maxBucketsM2M =
      opts.maxBuckets ??
      (precisionM2M === "exact" ? 100_000 : precisionM2M === "sampled" ? 10_000 : 1);
    if (precisionM2M !== "fast") {
      const targetPkSet = await collectPkSet(targetIndex, maxBucketsM2M, securityFilter, branchId);
      let danglingRows = 0;
      for (const row of rows) {
        if (!targetPkSet.has(row.target)) danglingRows += 1;
      }
      const resolvedRows = rows.length - danglingRows;
      danglingEdges = danglingRows;
      totalLinkCount = resolvedRows;
    }
  } else {
    // FK-based analysis
    let fkField: string | null = null;
    let fkIndex = sourceIndex;

    if (cardinality === "ONE_TO_MANY" || (cardinality === "MANY_TO_MANY" && linkType.target_property_id)) {
      fkField = linkType.target_property_id ? await getPropertyApiName(linkType.target_property_id) : null;
      fkIndex = targetIndex;
    } else if (cardinality === "MANY_TO_ONE" && linkType.source_property_id) {
      fkField = await getPropertyApiName(linkType.source_property_id);
      fkIndex = sourceIndex;
    } else if (cardinality === "ONE_TO_ONE") {
      if (linkType.source_property_id) {
        fkField = await getPropertyApiName(linkType.source_property_id);
        fkIndex = sourceIndex;
      } else if (linkType.target_property_id) {
        fkField = await getPropertyApiName(linkType.target_property_id);
        fkIndex = targetIndex;
      }
    }

    if (fkField) {
      // Foundry semantics — link analysis counts RESOLVED edges against
      // indexed target objects, not merely populated foreign keys. A
      // populated FK whose value matches no indexed target `__pk` is a
      // DANGLING edge: it would inflate a naive "populated FK" count but
      // never resolves at traversal time. We therefore intersect the
      // distinct FK values present in the FK-side index against the
      // `__pk` set of the joined side. `totalLinkCount` is the resolved
      // edge count; `danglingEdges` is populated-FK-minus-resolved.
      //
      // This eliminates the historical contradiction
      // "links > 0 with targets = 0": if the joined-side index is
      // empty/stale its `__pk` set is empty, so EVERY populated FK is
      // dangling and `totalLinkCount` is 0 — consistent with
      // `totalTargetObjects === 0`, and the invariant
      // `totalLinkCount > 0 ⇒ totalTargetObjects > 0` holds by
      // construction.

      // The joined side is the side whose `__pk` the FK resolves to.
      const pkSetIndex = fkIndex === sourceIndex ? targetIndex : sourceIndex;

      // Objects with the FK field populated at all (resolved + dangling).
      const totalInFkIndex = await countIndex(fkIndex, { match_all: {} }, securityFilter, branchId);
      const withFk = await countIndex(fkIndex, { exists: { field: fkField } }, securityFilter, branchId);
      // Objects on the FK side with no FK populated at all = unlinked.
      sourcesWithNoLinks = totalInFkIndex - withFk;

      const precision: AnalysisPrecision = opts.precision ?? "sampled";
      const maxBuckets =
        opts.maxBuckets ??
        (precision === "exact" ? 100_000 : precision === "sampled" ? 10_000 : 1);

      // Distinct FK values + per-value counts in the FK-side index.
      const terms =
        precision === "fast"
          ? []
          : await collectCompositeTerms(fkIndex, fkField, maxBuckets, securityFilter, branchId);
      // Set of primary keys present in the joined side (capped).
      const pkSet = await collectPkSet(pkSetIndex, maxBuckets, securityFilter, branchId);

      let resolvedLinkCount = 0;
      let distinctResolvedKeys = 0;
      const resolvedFanout: number[] = [];
      for (const t of terms) {
        if (pkSet.has(t.value)) {
          resolvedLinkCount += t.count;
          distinctResolvedKeys += 1;
          resolvedFanout.push(t.count);
        }
      }
      const populatedButUnresolved = Math.max(0, withFk - resolvedLinkCount);

      // `totalLinkCount` is now RESOLVED edges only.
      totalLinkCount = resolvedLinkCount;
      danglingEdges = populatedButUnresolved;
      // For precision=fast we did not page terms; fall back to the
      // populated-FK count for totalLinkCount so the cheap path stays
      // meaningful, but DO NOT claim resolution the cheap path cannot
      // prove — leave danglingEdges at 0 only when we genuinely could
      // not compute it.
      if (precision === "fast") {
        totalLinkCount = withFk;
        // fast cannot prove resolution; report populated as the link
        // count and surface 0 dangling only if the joined index is
        // demonstrably empty (no targets at all).
        danglingEdges = totalTargetObjects === 0 ? withFk : 0;
      }

      // targetsWithNoLinks / sourcesWithNoLinks on the non-FK side:
      // objects that no RESOLVED edge points at.
      if (cardinality === "ONE_TO_MANY") {
        // FK on target; sources with no links = sources no target resolves to.
        sourcesWithNoLinks = Math.max(0, totalSourceObjects - distinctResolvedKeys);
        targetsWithNoLinks = totalInFkIndex - withFk;
      } else if (cardinality === "MANY_TO_ONE") {
        // FK on source; targets with no links = targets no source resolves to.
        targetsWithNoLinks = Math.max(0, totalTargetObjects - distinctResolvedKeys);
      } else {
        // ONE_TO_ONE or fallback.
        targetsWithNoLinks = Math.max(0, totalTargetObjects - totalLinkCount);
      }

      // Distribution over RESOLVED-edge fanout only.
      try {
        const counts = resolvedFanout.slice().sort((a, b) => a - b);
        if (counts.length > 0) {
          distribution = computeDistribution(counts);
          (distribution as any).p95 = percentile(counts, 0.95);
          (distribution as any).p99_9 = percentile(counts, 0.999);
        }
      } catch {
        const totalInIndex = await countIndex(fkIndex, { match_all: {} }, securityFilter, branchId);
        distribution = {
          min: 0,
          max: totalLinkCount > 0 ? 1 : 0,
          avg: totalInIndex > 0 ? totalLinkCount / totalInIndex : 0,
          p50: totalLinkCount > 0 ? 1 : 0,
          p90: totalLinkCount > 0 ? 1 : 0,
          p99: totalLinkCount > 0 ? 1 : 0,
        };
      }
    }
  }

  const precisionOut: AnalysisPrecision = opts.precision ?? "sampled";
  const computationMethod: "composite_agg" | "iceberg_scan" | "sampling" =
    linkType.storage_backend === "iceberg"
      ? "iceberg_scan"
      : precisionOut === "exact"
        ? "composite_agg"
        : "sampling";

  return {
    linkTypeApiName: linkType.api_name,
    sourceObjectType: sourceOtApiName,
    targetObjectType: targetOtApiName,
    cardinality: linkType.cardinality,
    totalSourceObjects,
    totalTargetObjects,
    totalLinkCount,
    totalLinkCountExact: precisionOut === "exact" ? totalLinkCount : undefined,
    totalLinkCountMethod: precisionOut === "exact" ? "exact" : "approximate",
    danglingEdges,
    danglingEdgesExact: precisionOut === "exact" ? danglingEdges : undefined,
    sourcesWithNoLinks,
    sourcesWithNoLinksEstimate:
      precisionOut === "sampled" ? sourcesWithNoLinks : undefined,
    targetsWithNoLinks,
    distribution,
    computationMethod,
    sampledFraction: precisionOut === "sampled" ? 0.1 : 1,
  };
}

function computeDistribution(sortedCounts: number[]): { min: number; max: number; avg: number; p50: number; p90: number; p99: number } {
  const n = sortedCounts.length;
  const sum = sortedCounts.reduce((a, b) => a + b, 0);
  return {
    min: sortedCounts[0],
    max: sortedCounts[n - 1],
    avg: Math.round((sum / n) * 100) / 100,
    p50: sortedCounts[Math.floor(n * 0.5)],
    p90: sortedCounts[Math.floor(n * 0.9)],
    p99: sortedCounts[Math.min(Math.floor(n * 0.99), n - 1)],
  };
}

// ---------------------------------------------------------------------------
// Cardinality Migration Validation
// ---------------------------------------------------------------------------

export async function validateCardinalityChange(
  linkType: LinkTypeRow,
  targetCardinality: Cardinality
): Promise<CardinalityValidation> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const sourceOtApiName = await getObjectTypeApiName(linkType.source_object_type);
  const targetOtApiName = await getObjectTypeApiName(linkType.target_object_type);

  // Rule: Can't change from M2M to anything without data migration
  if (linkType.cardinality === "MANY_TO_MANY" && targetCardinality !== "MANY_TO_MANY") {
    if (linkType.join_table_file_path) {
      errors.push("Cannot change from MANY_TO_MANY with join table to FK-based cardinality without data migration.");
    }
  }

  // Rule: Changing to ONE_TO_ONE or MANY_TO_ONE requires no duplicates on FK side
  if (targetCardinality === "ONE_TO_ONE" || targetCardinality === "MANY_TO_ONE") {
    if (!linkType.source_property_id && !linkType.target_property_id) {
      errors.push(`${targetCardinality} requires at least one FK property to be set.`);
    }
  }

  // Rule: Changing to ONE_TO_MANY requires target FK property
  if (targetCardinality === "ONE_TO_MANY") {
    if (!linkType.target_property_id) {
      warnings.push("ONE_TO_MANY typically requires target_property_id to be set.");
    }
  }

  // Rule: Relaxing cardinality is always safe
  const relaxations: Record<string, string[]> = {
    ONE_TO_ONE: ["ONE_TO_MANY", "MANY_TO_ONE", "MANY_TO_MANY"],
    ONE_TO_MANY: ["MANY_TO_MANY"],
    MANY_TO_ONE: ["MANY_TO_MANY"],
  };

  const safeTargets = relaxations[linkType.cardinality] || [];
  if (safeTargets.includes(targetCardinality)) {
    warnings.push(`Relaxing from ${linkType.cardinality} to ${targetCardinality} is safe.`);
  }

  return {
    canMigrate: errors.length === 0,
    warnings,
    errors,
    currentCardinality: linkType.cardinality,
    targetCardinality,
  };
}

// ---------------------------------------------------------------------------
// FK Validation (for actions)
// ---------------------------------------------------------------------------

export async function validateForeignKeys(
  objectTypeId: string,
  objectData: Record<string, unknown>,
  ontologyId: string,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<FKValidationResult> {
  const warnings: string[] = [];
  const orphanedReferences: Array<{ property: string; value: string; targetType: string }> = [];

  // Find all link types where this object type is the source
  const linkTypes = await query(
    "SELECT * FROM link_type WHERE ontology_id = $1 AND source_object_type = $2",
    [ontologyId, objectTypeId]
  );

  for (const lt of linkTypes.rows as LinkTypeRow[]) {
    if (!lt.source_property_id) continue;

    const propName = await getPropertyApiName(lt.source_property_id);
    const fkValue = objectData[propName];

    if (fkValue === null || fkValue === undefined || fkValue === "") continue;

    const targetOtApiName = await getObjectTypeApiName(lt.target_object_type);
    const targetIndex = getIndexName(targetOtApiName);
    const doc = await getDocByPK(targetIndex, String(fkValue), securityFilter, branchId);

    if (!doc) {
      orphanedReferences.push({ property: propName, value: String(fkValue), targetType: targetOtApiName });
      warnings.push(`FK property '${propName}' references non-existent ${targetOtApiName} '${fkValue}'.`);
    }
  }

  return {
    valid: true, // Palantir always returns valid, orphans are warnings
    warnings,
    orphanedReferences,
  };
}

// ---------------------------------------------------------------------------
// Join Table Validation
// ---------------------------------------------------------------------------

export async function validateJoinTable(
  linkType: LinkTypeRow,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<JoinTableValidation> {
  if (!linkType.join_table_file_path) {
    return {
      valid: false,
      totalRows: 0,
      uniqueSourceKeys: 0,
      uniqueTargetKeys: 0,
      orphanedSourceKeys: [],
      orphanedTargetKeys: [],
      duplicateRows: 0,
      warnings: ["No join table file path configured."],
    };
  }

  const rows = parseJoinTableCSV(linkType.join_table_file_path);
  const sourceOtApiName = await getObjectTypeApiName(linkType.source_object_type);
  const targetOtApiName = await getObjectTypeApiName(linkType.target_object_type);
  const sourceIndex = getIndexName(sourceOtApiName);
  const targetIndex = getIndexName(targetOtApiName);

  const uniqueSourcePKs = new Set(rows.map((r) => r.source));
  const uniqueTargetPKs = new Set(rows.map((r) => r.target));

  // Check for duplicates
  const rowSet = new Set<string>();
  let duplicateRows = 0;
  for (const row of rows) {
    const key = `${row.source}:${row.target}`;
    if (rowSet.has(key)) {
      duplicateRows++;
    } else {
      rowSet.add(key);
    }
  }

  // Check for orphaned source keys (batch check via terms query)
  const orphanedSourceKeys: string[] = [];
  const orphanedTargetKeys: string[] = [];
  const warnings: string[] = [];

  const sourceArr = Array.from(uniqueSourcePKs);
  const targetArr = Array.from(uniqueTargetPKs);

  // Check sources exist
  if (sourceArr.length > 0) {
    try {
      const existing = await searchIndex(sourceIndex, [{ terms: { __pk: sourceArr.slice(0, 10000) } }], 0, 10000, undefined, securityFilter, branchId);
      const existingPKs = new Set(existing.hits.map((h) => String(h.__pk)));
      for (const pk of sourceArr.slice(0, 10000)) {
        if (!existingPKs.has(pk)) {
          orphanedSourceKeys.push(pk);
        }
      }
    } catch {
      warnings.push("Could not verify source keys against OpenSearch.");
    }
  }

  // Check targets exist
  if (targetArr.length > 0) {
    try {
      const existing = await searchIndex(targetIndex, [{ terms: { __pk: targetArr.slice(0, 10000) } }], 0, 10000, undefined, securityFilter, branchId);
      const existingPKs = new Set(existing.hits.map((h) => String(h.__pk)));
      for (const pk of targetArr.slice(0, 10000)) {
        if (!existingPKs.has(pk)) {
          orphanedTargetKeys.push(pk);
        }
      }
    } catch {
      warnings.push("Could not verify target keys against OpenSearch.");
    }
  }

  if (orphanedSourceKeys.length > 0) {
    warnings.push(`${orphanedSourceKeys.length} source key(s) reference non-existent objects.`);
  }
  if (orphanedTargetKeys.length > 0) {
    warnings.push(`${orphanedTargetKeys.length} target key(s) reference non-existent objects.`);
  }
  if (duplicateRows > 0) {
    warnings.push(`${duplicateRows} duplicate row(s) found in join table.`);
  }

  return {
    valid: true, // warnings, not errors
    totalRows: rows.length,
    uniqueSourceKeys: uniqueSourcePKs.size,
    uniqueTargetKeys: uniqueTargetPKs.size,
    orphanedSourceKeys,
    orphanedTargetKeys,
    duplicateRows,
    warnings,
  };
}

export default { resolveLinks, countLinks, bulkCountLinks, searchAround, resolveMultiHop, analyzeLinkType, validateCardinalityChange, validateForeignKeys, validateJoinTable };

// ---------------------------------------------------------------------------
// Inline self-tests
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) { passed++; } else { failed++; console.error(`  FAIL: ${label}`); }
  }

  console.log("Running linkResolverService self-tests...\n");

  // Test helper functions
  assert(termField("__pk") === "__pk", "termField: system field unchanged");
  assert(termField("name") === "name.keyword", "termField: user field gets .keyword");
  assert(termField("name.keyword") === "name.keyword", "termField: already qualified unchanged");

  // Test buildFilterClauses
  const clauses = buildFilterClauses({ name: "test", age: 30 });
  assert(clauses.length === 2, "buildFilterClauses: 2 filters");
  assert(JSON.stringify(clauses[0]).includes("name.keyword"), "buildFilterClauses: first is name.keyword");

  const emptyClauses = buildFilterClauses(undefined);
  assert(emptyClauses.length === 0, "buildFilterClauses: undefined returns empty");

  const emptyClauses2 = buildFilterClauses({});
  assert(emptyClauses2.length === 0, "buildFilterClauses: empty obj returns empty");

  // Test token encode/decode
  assert(decodeToken(undefined) === 0, "decodeToken: undefined -> 0");
  assert(decodeToken("") === 0, "decodeToken: empty -> 0");
  const token = encodeToken(42);
  assert(decodeToken(token) === 42, "encodeToken/decodeToken roundtrip");
  assert(decodeToken("invalid") === 0, "decodeToken: invalid -> 0");

  // Test computeDistribution
  const dist = computeDistribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert(dist.min === 1, "distribution min");
  assert(dist.max === 10, "distribution max");
  assert(dist.avg === 5.5, "distribution avg");
  assert(dist.p50 === 6, "distribution p50");

  // Test parseJoinTableCSV with non-existent file
  const noRows = parseJoinTableCSV("/nonexistent/path.csv");
  assert(noRows.length === 0, "parseJoinTableCSV: non-existent file returns []");

  // Test getTargetPKsFromJoinTable with non-existent file
  const noPKs = getTargetPKsFromJoinTable("/nonexistent/path.csv", "pk1");
  assert(noPKs.length === 0, "getTargetPKsFromJoinTable: non-existent returns []");

  // Test getSourcePKsFromJoinTable with non-existent file
  const noSrcPKs = getSourcePKsFromJoinTable("/nonexistent/path.csv", "pk1");
  assert(noSrcPKs.length === 0, "getSourcePKsFromJoinTable: non-existent returns []");

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll linkResolverService tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
