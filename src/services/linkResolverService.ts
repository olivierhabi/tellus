// ---------------------------------------------------------------------------
// Link Resolver Service
//
// Resolves linked objects for a given primary key across all four
// cardinalities by querying OpenSearch indices. In Palantir's architecture,
// link resolution is the core of "Search Around" — given an object, find
// all related objects through typed links.
//
// Resolution strategy (FK-based):
//   ONE_TO_MANY forward:  source PK → search target index where
//                         target FK property = source PK value
//   ONE_TO_MANY reverse:  target doc → read its FK property → get source
//   MANY_TO_ONE forward:  source doc → read its FK property → get target
//   MANY_TO_ONE reverse:  target PK → search source index where
//                         source FK property = target PK value
//   ONE_TO_ONE:           either direction via FK property on either side
//   MANY_TO_MANY:         search both sides via FK properties
// ---------------------------------------------------------------------------

import { client } from "./opensearch/client";
import { getIndexName } from "./opensearch/indexLifecycleManager";
import { query } from "../db";
import { appError } from "../utils/appError";
import type { LinkTypeRow, Cardinality } from "../models/linkType";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  pageSize?: number;
  pageToken?: string;
  targetFilter?: Record<string, unknown>;
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the OpenSearch field name suitable for `term` (exact-match) queries.
 *
 * System fields (__pk, __objectType, etc.) are mapped as `keyword` directly,
 * so they can be used as-is. User-defined `string` properties are mapped as
 * `text` with a `.keyword` sub-field — `term` queries on `text` fields fail
 * because the text is analyzed. Appending `.keyword` forces an exact match
 * against the un-analyzed sub-field.
 */
function termField(field: string): string {
  if (field.startsWith("__")) return field;        // system field — already keyword
  if (field.endsWith(".keyword")) return field;     // already qualified
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
  size: number
): Promise<{ hits: Array<Record<string, unknown>>; total: number }> {
  const body: Record<string, unknown> = {
    from,
    size,
    query: musts.length === 1 ? musts[0] : { bool: { must: musts } },
  };

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
// Core resolution
// ---------------------------------------------------------------------------

/**
 * Resolve linked objects for a given object's primary key through a link type.
 *
 * @param linkType  - The link type definition from the DB.
 * @param objectPK  - The primary key of the starting object.
 * @param direction - "forward" (source→target) or "reverse" (target→source).
 * @param options   - Pagination and filtering options.
 */
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
      // Source PK → search target index where target's FK property = source PK
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
      // Source doc has FK property pointing to target PK → read source, get FK, fetch target
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
      // Try: source has FK → target (source_property_id points to target PK)
      // OR: target has FK → source (target_property_id points to source PK)
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
        return { linkedObjects: hits, totalCount: total, nextPageToken: null };
      }
      if (linkType.target_property_id) {
        const targetPropName = await getPropertyApiName(linkType.target_property_id);
        const musts: Array<Record<string, unknown>> = [
          { term: { [termField(targetPropName)]: sourcePK } },
          ...filterClauses,
        ];
        const { hits, total } = await searchIndex(targetIndex, musts, 0, 1);
        return { linkedObjects: hits, totalCount: total, nextPageToken: null };
      }
      return { linkedObjects: [], totalCount: 0, nextPageToken: null };
    }

    case "MANY_TO_MANY": {
      // Target index has FK referencing source PK
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
      // Reverse: target doc has FK → source PK. Read target doc's FK, fetch source.
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
      // Reverse: source FK = target PK. Search source index where source FK = targetPK.
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
      // Reverse of ONE_TO_ONE: if source has FK, search source where FK = targetPK
      // If target has FK, read target doc FK value, fetch source
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
      // Reverse: search source index where source FK = target PK
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
  const result = await resolveLinks(linkType, objectPK, direction, { pageSize: 0 });
  // For count, re-run with size=0 to get total only
  const sourceOtApiName = await getObjectTypeApiName(linkType.source_object_type);
  const targetOtApiName = await getObjectTypeApiName(linkType.target_object_type);
  const cardinality = linkType.cardinality as Cardinality;

  if (direction === "forward") {
    const res = await resolveForward(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, 0, 0, []);
    return res.totalCount;
  } else {
    const res = await resolveReverse(linkType, objectPK, sourceOtApiName, targetOtApiName, cardinality, 0, 0, []);
    return res.totalCount;
  }
}

// ---------------------------------------------------------------------------
// Search Around
// ---------------------------------------------------------------------------

/**
 * Search Around: find all objects of one type that are linked to objects
 * of another type matching certain filters.
 */
export async function searchAround(
  linkType: LinkTypeRow,
  direction: "forward" | "reverse",
  options: SearchAroundOptions = {}
): Promise<ResolveResult> {
  const sourceOtApiName = await getObjectTypeApiName(linkType.source_object_type);
  const targetOtApiName = await getObjectTypeApiName(linkType.target_object_type);
  const pageSize = Math.min(options.pageSize ?? 100, 1000);
  const from = decodeToken(options.pageToken);

  // Step 1: Find source objects matching sourceFilter
  const searchOtApiName = direction === "forward" ? sourceOtApiName : targetOtApiName;
  const searchIndex = getIndexName(searchOtApiName);
  const sourceFilterClauses = buildFilterClauses(options.sourceFilter);

  const sourceQuery: Record<string, unknown> = sourceFilterClauses.length > 0
    ? { bool: { must: sourceFilterClauses } }
    : { match_all: {} };

  let sourcePKs: string[] = [];
  try {
    const { body: resp } = await client.search({
      index: searchIndex,
      body: { size: 1000, _source: ["__pk"], query: sourceQuery },
    });
    const hitsObj = (resp as any).hits;
    sourcePKs = (hitsObj.hits as any[]).map((h: any) => h._source.__pk as string);
  } catch {
    return { linkedObjects: [], totalCount: 0, nextPageToken: null };
  }

  if (sourcePKs.length === 0) {
    return { linkedObjects: [], totalCount: 0, nextPageToken: null };
  }

  // Step 2: For each source PK, resolve links and aggregate
  const allLinked: Array<Record<string, unknown>> = [];
  const seenPKs = new Set<string>();

  for (const pk of sourcePKs) {
    const result = await resolveLinks(linkType, pk, direction, {
      pageSize: 1000,
      targetFilter: options.targetFilter,
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

  return { linkedObjects: paged, totalCount: total, nextPageToken };
}

export default { resolveLinks, countLinks, searchAround };
