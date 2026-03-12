// ---------------------------------------------------------------------------
// Link Resolver Service (Thursday Enhanced)
//
// Resolves linked objects for a given primary key across all four
// cardinalities by querying OpenSearch indices. Supports FK-based links
// and CSV join table-based M2M links. Includes self-referential link
// support, multi-hop traversal, link analysis, and Search Around.
// ---------------------------------------------------------------------------

import { client } from "./opensearch/client";
import { getIndexName } from "./opensearch/indexLifecycleManager";
import { query } from "../db";
import { appError } from "../utils/appError";
import type { LinkTypeRow, Cardinality } from "../models/linkType";
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
  targetFilter?: Record<string, unknown>;
  pageSize?: number;
  pageToken?: string;
  direction?: "forward" | "reverse";
}

export interface LinkAnalysis {
  linkTypeApiName: string;
  sourceObjectType: string;
  targetObjectType: string;
  cardinality: string;
  totalSourceObjects: number;
  totalTargetObjects: number;
  totalLinkCount: number;
  sourcesWithNoLinks: number;
  targetsWithNoLinks: number;
  distribution: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p90: number;
    p99: number;
  };
}

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
  sort?: Array<Record<string, unknown>>
): Promise<{ hits: Array<Record<string, unknown>>; total: number }> {
  const body: Record<string, unknown> = {
    from,
    size,
    query: musts.length === 1 ? musts[0] : { bool: { must: musts } },
  };
  if (sort && sort.length > 0) {
    body.sort = sort;
  }

  try {
    const { body: resp } = await client.search({ index: indexName, body });
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
  queryBody: Record<string, unknown>
): Promise<number> {
  try {
    const { body: resp } = await client.count({ index: indexName, body: { query: queryBody } });
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
  pk: string
): Promise<Record<string, unknown> | null> {
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
  options: ResolveOptions = {}
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
    return resolveForward(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, from, pageSize, filterClauses);
  } else {
    return resolveReverse(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, from, pageSize, filterClauses);
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
  filterClauses: Array<Record<string, unknown>>
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
      const { hits, total } = await searchIndex(targetIndex, musts, from, size);
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
      const sourceDoc = await getDocByPK(sourceIndex, sourcePK);
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
      const { hits, total } = await searchIndex(targetIndex, musts, from, size);
      return { linkedObjects: hits, totalCount: total, nextPageToken: null };
    }

    case "ONE_TO_ONE": {
      if (linkType.source_property_id) {
        const sourcePropName = await getPropertyApiName(linkType.source_property_id);
        const sourceDoc = await getDocByPK(sourceIndex, sourcePK);
        if (!sourceDoc) return { linkedObjects: [], totalCount: 0, nextPageToken: null };
        const fkValue = sourceDoc[sourcePropName];
        if (fkValue === null || fkValue === undefined || fkValue === "") {
          return { linkedObjects: [], totalCount: 0, nextPageToken: null };
        }
        const musts: Array<Record<string, unknown>> = [
          { term: { __pk: String(fkValue) } },
          ...filterClauses,
        ];
        const { hits, total } = await searchIndex(targetIndex, musts, 0, 1);
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
        const { hits, total } = await searchIndex(targetIndex, musts, 0, 1);
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
        const { hits, total } = await searchIndex(targetIndex, musts, from, size);
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
      const { hits, total } = await searchIndex(targetIndex, musts, from, size);
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
  filterClauses: Array<Record<string, unknown>>
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
      const targetDoc = await getDocByPK(targetIndex, targetPK);
      if (!targetDoc) return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      const fkValue = targetDoc[targetPropName];
      if (fkValue === null || fkValue === undefined || fkValue === "") {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null };
      }
      const musts: Array<Record<string, unknown>> = [
        { term: { __pk: String(fkValue) } },
        ...filterClauses,
      ];
      const { hits, total } = await searchIndex(sourceIndex, musts, 0, 1);
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
      const { hits, total } = await searchIndex(sourceIndex, musts, from, size);
      const nextPageToken = from + size < total ? encodeToken(from + size) : null;
      return { linkedObjects: hits, totalCount: total, nextPageToken };
    }

    case "ONE_TO_ONE": {
      if (linkType.source_property_id) {
        const sourcePropName = await getPropertyApiName(linkType.source_property_id);
        const musts: Array<Record<string, unknown>> = [
          { term: { [termField(sourcePropName)]: targetPK } },
          ...filterClauses,
        ];
        const { hits, total } = await searchIndex(sourceIndex, musts, 0, 1);
        return { linkedObjects: hits, totalCount: total, nextPageToken: null };
      }
      if (linkType.target_property_id) {
        const targetPropName = await getPropertyApiName(linkType.target_property_id);
        const targetDoc = await getDocByPK(targetIndex, targetPK);
        if (!targetDoc) return { linkedObjects: [], totalCount: 0, nextPageToken: null };
        const fkValue = targetDoc[targetPropName];
        if (fkValue === null || fkValue === undefined || fkValue === "") {
          return { linkedObjects: [], totalCount: 0, nextPageToken: null };
        }
        const musts: Array<Record<string, unknown>> = [
          { term: { __pk: String(fkValue) } },
          ...filterClauses,
        ];
        const { hits, total } = await searchIndex(sourceIndex, musts, 0, 1);
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
        const { hits, total } = await searchIndex(sourceIndex, musts, from, size);
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
      const { hits, total } = await searchIndex(sourceIndex, musts, from, size);
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
  direction: "forward" | "reverse"
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
        return countIndex(getIndexName(targetOtApiName), { term: { [termField(targetPropName)]: objectPK } });
      }
      case "MANY_TO_ONE": {
        const sourcePropName = linkType.source_property_id
          ? await getPropertyApiName(linkType.source_property_id) : null;
        if (!sourcePropName) return 0;
        const sourceDoc = await getDocByPK(getIndexName(sourceOtApiName), objectPK);
        if (!sourceDoc) return 0;
        const fkVal = sourceDoc[sourcePropName];
        if (fkVal === null || fkVal === undefined || fkVal === "") return 0;
        return countIndex(getIndexName(targetOtApiName), { term: { __pk: String(fkVal) } });
      }
      case "ONE_TO_ONE": {
        const res = await resolveForward(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, 0, 1, []);
        return res.totalCount;
      }
      case "MANY_TO_MANY": {
        if (linkType.join_table_file_path) {
          const targetPKs = getTargetPKsFromJoinTable(linkType.join_table_file_path, objectPK);
          return targetPKs.length;
        }
        const targetPropName = linkType.target_property_id
          ? await getPropertyApiName(linkType.target_property_id) : null;
        if (!targetPropName) return 0;
        return countIndex(getIndexName(targetOtApiName), { term: { [termField(targetPropName)]: objectPK } });
      }
      default: return 0;
    }
  } else {
    switch (cardinality) {
      case "ONE_TO_MANY": {
        const res = await resolveReverse(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, 0, 1, []);
        return res.totalCount;
      }
      case "MANY_TO_ONE": {
        const sourcePropName = linkType.source_property_id
          ? await getPropertyApiName(linkType.source_property_id) : null;
        if (!sourcePropName) return 0;
        return countIndex(getIndexName(sourceOtApiName), { term: { [termField(sourcePropName)]: objectPK } });
      }
      case "ONE_TO_ONE": {
        const res = await resolveReverse(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, 0, 1, []);
        return res.totalCount;
      }
      case "MANY_TO_MANY": {
        if (linkType.join_table_file_path) {
          const sourcePKs = getSourcePKsFromJoinTable(linkType.join_table_file_path, objectPK);
          return sourcePKs.length;
        }
        const sourcePropName = linkType.source_property_id
          ? await getPropertyApiName(linkType.source_property_id) : null;
        if (!sourcePropName) return 0;
        return countIndex(getIndexName(sourceOtApiName), { term: { [termField(sourcePropName)]: objectPK } });
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
  objectPK: string
): Promise<Array<{ linkTypeApiName: string; direction: string; count: number | null; error?: string }>> {
  const { listByObjectType } = await import("../models/linkType");
  const linkTypes = await listByObjectType(ontologyId, objectTypeId);

  const results = await Promise.allSettled(
    linkTypes.map(async (lt) => {
      const count = await countLinks(lt, objectPK, lt.direction);
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
  options: SearchAroundOptions = {}
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

  const sourceQuery: Record<string, unknown> = sourceFilterClauses.length > 0
    ? { bool: { must: sourceFilterClauses } }
    : { match_all: {} };

  let sourcePKs: string[] = [];
  const MAX_SOURCE = 100000;
  try {
    const { body: resp } = await client.search({
      index: searchIndexName,
      body: { size: MAX_SOURCE, _source: ["__pk"], query: sourceQuery },
    });
    const hitsObj = (resp as any).hits;
    const totalHits = typeof hitsObj.total === "object" ? hitsObj.total.value : hitsObj.total;
    sourcePKs = (hitsObj.hits as any[]).map((h: any) => h._source.__pk as string);

    if (totalHits > MAX_SOURCE) {
      warnings.push(`Source filter matched ${totalHits} objects but only first ${MAX_SOURCE} were used.`);
    }
  } catch {
    return { linkedObjects: [], totalCount: 0, nextPageToken: null, warnings };
  }

  if (sourcePKs.length === 0) {
    return { linkedObjects: [], totalCount: 0, nextPageToken: null, warnings };
  }

  // Step 2: Bulk resolve - build a single query for all source PKs
  const cardinality = linkType.cardinality as Cardinality;
  const targetFilterClauses = buildFilterClauses(options.targetFilter);
  const resolveOtApiName = direction === "forward" ? targetOtApiName : sourceOtApiName;
  const resolveIndexName = getIndexName(resolveOtApiName);

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
    const { hits, total } = await searchIndex(resolveIndexName, musts, from, pageSize);
    const nextPageToken = from + pageSize < total ? encodeToken(from + pageSize) : null;
    return { linkedObjects: hits, totalCount: total, nextPageToken, warnings };
  }

  // For M2M with join table
  if (cardinality === "MANY_TO_MANY" && linkType.join_table_file_path) {
    const allTargetPKs = new Set<string>();
    const rows = parseJoinTableCSV(linkType.join_table_file_path);
    for (const pk of sourcePKs) {
      if (direction === "forward") {
        rows.filter((r) => r.source === pk).forEach((r) => allTargetPKs.add(r.target));
      } else {
        rows.filter((r) => r.target === pk).forEach((r) => allTargetPKs.add(r.source));
      }
    }
    if (allTargetPKs.size === 0) {
      return { linkedObjects: [], totalCount: 0, nextPageToken: null, warnings };
    }
    const musts: Array<Record<string, unknown>> = [
      { terms: { __pk: Array.from(allTargetPKs).slice(0, 100000) } },
      ...targetFilterClauses,
    ];
    const { hits, total } = await searchIndex(resolveIndexName, musts, from, pageSize);
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
    });
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

export async function resolveMultiHop(
  steps: MultiHopStep[],
  startingPKs: string[],
  options: ResolveOptions = {}
): Promise<ResolveResult & { hopsCompleted: number }> {
  if (steps.length > 5) {
    throw appError("VALIDATION_FAILED", "Maximum 5 hops allowed.");
  }
  if (steps.length === 0) {
    throw appError("VALIDATION_FAILED", "At least 1 hop is required.");
  }

  const MAX_INTERMEDIATE = 100000;
  let currentPKs = startingPKs;
  const { getByApiName } = await import("../models/linkType");

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const linkType = await getByApiName(step.ontologyId, step.linkTypeApiName);
    if (!linkType) {
      throw appError("LINK_TYPE_NOT_FOUND", `Link type '${step.linkTypeApiName}' not found.`);
    }

    const isLastHop = i === steps.length - 1;
    const nextPKs = new Set<string>();

    for (const pk of currentPKs) {
      const result = await resolveLinks(linkType, pk, step.direction, {
        pageSize: isLastHop ? options.pageSize : 1000,
        excludeSelf: true,
      });
      for (const obj of result.linkedObjects) {
        nextPKs.add(String(obj.__pk ?? ""));
      }
    }

    if (isLastHop) {
      // For the last hop, return full objects with pagination
      const allPKs = Array.from(nextPKs).slice(0, MAX_INTERMEDIATE);

      // Determine the target index for the last hop
      const targetOtId = step.direction === "forward"
        ? linkType.target_object_type
        : linkType.source_object_type;
      const targetOtApiName = await getObjectTypeApiName(targetOtId);
      const targetIndex = getIndexName(targetOtApiName);

      const pageSize = Math.min(options.pageSize ?? 100, 1000);
      const from = decodeToken(options.pageToken);
      const filterClauses = buildFilterClauses(options.targetFilter);

      if (allPKs.length === 0) {
        return { linkedObjects: [], totalCount: 0, nextPageToken: null, hopsCompleted: i + 1 };
      }

      const musts: Array<Record<string, unknown>> = [
        { terms: { __pk: allPKs } },
        ...filterClauses,
      ];
      const { hits, total } = await searchIndex(targetIndex, musts, from, pageSize);
      const nextPageToken = from + pageSize < total ? encodeToken(from + pageSize) : null;
      return { linkedObjects: hits, totalCount: total, nextPageToken, hopsCompleted: i + 1 };
    }

    currentPKs = Array.from(nextPKs).slice(0, MAX_INTERMEDIATE);
    if (currentPKs.length === 0) {
      return { linkedObjects: [], totalCount: 0, nextPageToken: null, hopsCompleted: i + 1 };
    }
  }

  return { linkedObjects: [], totalCount: 0, nextPageToken: null, hopsCompleted: steps.length };
}

// ---------------------------------------------------------------------------
// Link Analysis
// ---------------------------------------------------------------------------

export async function analyzeLinkType(
  linkType: LinkTypeRow
): Promise<LinkAnalysis> {
  const sourceOtApiName = await getObjectTypeApiName(linkType.source_object_type);
  const targetOtApiName = await getObjectTypeApiName(linkType.target_object_type);
  const sourceIndex = getIndexName(sourceOtApiName);
  const targetIndex = getIndexName(targetOtApiName);

  // Get total counts
  const totalSourceObjects = await countIndex(sourceIndex, { match_all: {} });
  const totalTargetObjects = await countIndex(targetIndex, { match_all: {} });

  let totalLinkCount = 0;
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
      // Count objects with non-null FK
      totalLinkCount = await countIndex(fkIndex, { exists: { field: fkField } });

      // Count objects without the FK field (sources with no links)
      const totalInFkIndex = await countIndex(fkIndex, { match_all: {} });
      const withFk = await countIndex(fkIndex, { exists: { field: fkField } });
      sourcesWithNoLinks = totalInFkIndex - withFk;

      // Compute targetsWithNoLinks: objects on the non-FK side that nobody points to
      // For ONE_TO_MANY: fkIndex=target, "other side" = source. Count sources not referenced.
      // For MANY_TO_ONE: fkIndex=source, "other side" = target. Count targets not referenced.
      try {
        if (cardinality === "ONE_TO_MANY") {
          // FK is on target side; sources with no links = sources not referenced by any target FK value
          // Use terms agg on FK field to find unique FK values (= unique source PKs referenced)
          const aggBody: Record<string, unknown> = {
            size: 0,
            aggs: {
              unique_refs: { cardinality: { field: termField(fkField) } },
            },
            query: { exists: { field: fkField } },
          };
          const { body: aggResp } = await client.search({ index: fkIndex, body: aggBody });
          const uniqueRefs = (aggResp as any).aggregations?.unique_refs?.value ?? 0;
          // Sources that no target points to
          sourcesWithNoLinks = Math.max(0, totalSourceObjects - uniqueRefs);
          // Targets that have no FK value
          targetsWithNoLinks = totalInFkIndex - withFk;
        } else if (cardinality === "MANY_TO_ONE") {
          // FK is on source side; targets with no links = targets not referenced by any source FK value
          const aggBody: Record<string, unknown> = {
            size: 0,
            aggs: {
              unique_refs: { cardinality: { field: termField(fkField) } },
            },
            query: { exists: { field: fkField } },
          };
          const { body: aggResp } = await client.search({ index: fkIndex, body: aggBody });
          const uniqueRefs = (aggResp as any).aggregations?.unique_refs?.value ?? 0;
          targetsWithNoLinks = Math.max(0, totalTargetObjects - uniqueRefs);
        } else {
          // ONE_TO_ONE or fallback
          targetsWithNoLinks = Math.max(0, totalTargetObjects - totalLinkCount);
        }
      } catch {
        targetsWithNoLinks = Math.max(0, totalTargetObjects - totalLinkCount);
      }

      // Use OpenSearch terms aggregation for real distribution
      try {
        const aggBody: Record<string, unknown> = {
          size: 0,
          aggs: {
            fk_distribution: {
              terms: {
                field: termField(fkField),
                size: 10000,
              },
            },
          },
          query: { exists: { field: fkField } },
        };
        const { body: aggResp } = await client.search({ index: fkIndex, body: aggBody });
        const buckets = (aggResp as any).aggregations?.fk_distribution?.buckets ?? [];
        if (buckets.length > 0) {
          const counts = buckets.map((b: any) => b.doc_count as number).sort((a: number, b: number) => a - b);
          distribution = computeDistribution(counts);
        } else {
          distribution = { min: 0, max: 0, avg: 0, p50: 0, p90: 0, p99: 0 };
        }
      } catch {
        // Fallback to simple estimate if aggregation fails
        const totalInIndex = await countIndex(fkIndex, { match_all: {} });
        distribution = { min: 0, max: totalLinkCount > 0 ? 1 : 0, avg: totalInIndex > 0 ? totalLinkCount / totalInIndex : 0, p50: totalLinkCount > 0 ? 1 : 0, p90: totalLinkCount > 0 ? 1 : 0, p99: totalLinkCount > 0 ? 1 : 0 };
      }
    }
  }

  return {
    linkTypeApiName: linkType.api_name,
    sourceObjectType: sourceOtApiName,
    targetObjectType: targetOtApiName,
    cardinality: linkType.cardinality,
    totalSourceObjects,
    totalTargetObjects,
    totalLinkCount,
    sourcesWithNoLinks,
    targetsWithNoLinks,
    distribution,
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
  ontologyId: string
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
    const doc = await getDocByPK(targetIndex, String(fkValue));

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
  linkType: LinkTypeRow
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
      const existing = await searchIndex(sourceIndex, [{ terms: { __pk: sourceArr.slice(0, 10000) } }], 0, 10000);
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
      const existing = await searchIndex(targetIndex, [{ terms: { __pk: targetArr.slice(0, 10000) } }], 0, 10000);
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

function runSelfTests(): void {
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
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
