// ---------------------------------------------------------------------------
// Object Query Routes — Express Router
//
// Implements the Object Set Service query API:
//   GET    /api/v1/objects/:objectType               — List objects
//   GET    /api/v1/objects/:objectType/:primaryKey    — Get single object
//   POST   /api/v1/objects/:objectType/search         — Search with filters
//   POST   /api/v1/objects/:objectType/searchFullText — Full-text search
//   POST   /api/v1/objects/:objectType/aggregate      — Aggregations
//
// Tasks 9-15, 16-20 combined.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from "express";
import { query } from "../db";
import {
  executeSearch,
  executeGetObject,
  executeAggregate,
  executeFullTextSearch,
} from "../services/queryExecutor";
import {
  validateSearchQuery,
  validateListQuery,
  validateAggregateQuery,
} from "../services/queryValidator";
import { resolveLinks, countLinks, searchAround, validateForeignKeys } from "../services/linkResolverService";
import linkTypeModel, { resolveObjectTypeApiName } from "../models/linkType";
import { sendSuccess, sendError } from "../utils/responseFormatter";
import { appError } from "../utils/appError";
import { buildSecurityFilter } from "../middleware/securityContext";
import { readBranchHeader } from "../middleware/branchHeader";
import { resolveBranchIdOrMain } from "../services/branchContext";
import { incCounter } from "../services/funnel/metrics";
import { routeMetric } from "../utils/routeInstrumentation";
import {
  applyOverlayToResults,
  mergeOverlayIntoSearch,
  readOverlay,
} from "../services/overlay/writebackOverlay";
import { getOverlayStore, markOverlayDegraded } from "../services/overlay/getOverlayStore";
import {
  hasServingPendingEdits,
  recomputeAggregationsOverRows,
  refilterMergedRows,
  RECONCILE_MAX_CANDIDATES,
} from "../services/effectiveObjects";
import { collectWhereFields } from "../services/security/propertyMarkingGuard";
import { recordShadowDiff } from "../services/funnel/shadowDiffHook";
import { CellMarkingService, redactCells } from "../services/security/cellMarkingService";
import {
  enforceQueryMarkings,
  stripRestrictedRows,
} from "../services/security/propertyMarkingGuard";

const router = Router();

// FOUNDRY-GAPS §8 — cell-level marking redaction at read time. Stateless over
// the shared `query` pool, so one instance is reused across requests.
const cellMarkingService = new CellMarkingService();

export type PropertyMarking = {
  api_name: string;
  column_name?: string | null;
  marking_required: string[] | string | null;
};

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Enforce the property-projection rule used by direct reads: unavailable
 * properties are omitted, never nulled or masked in the client. PostgreSQL
 * returns `text[]` for the current schema, while the string branch keeps
 * mixed-version deployments safe during migration 045.
 */
export function omitUnauthorizedProperties(
  properties: Record<string, unknown>,
  markings: readonly PropertyMarking[],
  grantedMarkings: ReadonlySet<string>,
  markingBypass = false,
): string[] {
  if (markingBypass) return [];
  const omitted: string[] = [];
  for (const row of markings) {
    const required = Array.isArray(row.marking_required)
      ? row.marking_required
      : typeof row.marking_required === "string" && row.marking_required
        ? [row.marking_required]
        : [];
    if (required.length === 0 || required.every((marking) => grantedMarkings.has(marking))) {
      continue;
    }
    // Object-serving documents can use the ontology API name or the mapped
    // datasource column. Remove every representation so an API-name policy
    // cannot leak through a snake_case backing field on direct reads.
    const aliases = new Set([row.api_name, snakeCase(row.api_name)]);
    if (row.column_name) aliases.add(row.column_name);
    let found = false;
    for (const property of aliases) {
      if (!Object.prototype.hasOwnProperty.call(properties, property)) continue;
      delete properties[property];
      found = true;
    }
    if (found) {
      omitted.push(row.api_name);
    }
  }
  return omitted;
}

type LinkedWhere = {
  type: "linked";
  ontologyId: string;
  linkTypeApiName: string;
  targetObjectTypeApiName: string;
  targetWhere?: Record<string, unknown>;
  negated?: boolean;
};

/** Resolve Filter List linked predicates into a primary-key predicate before
 * normal schema validation/query translation. Resolution happens against the
 * complete target result set (cursor-paged) and the canonical link service,
 * so aggregate/facet/chart queries all share identical traversal semantics. */
async function resolveLinkedWhere(
  where: unknown,
  sourceObjectType: string,
  securityFilter: Record<string, unknown> | null | undefined,
  branchId: string | null,
): Promise<unknown> {
  if (!where || typeof where !== "object" || Array.isArray(where)) return where;
  const node = where as Record<string, unknown>;
  if (node.type === "and" || node.type === "or") {
    const children = Array.isArray(node.value) ? node.value : [];
    return { ...node, value: await Promise.all(children.map((child) => resolveLinkedWhere(child, sourceObjectType, securityFilter, branchId))) };
  }
  if (node.type === "not") {
    const children = Array.isArray(node.value) ? node.value : [];
    return { ...node, value: await Promise.all(children.map((child) => resolveLinkedWhere(child, sourceObjectType, securityFilter, branchId))) };
  }
  if (node.type !== "linked") return where;

  const linked = node as unknown as LinkedWhere;
  if (!linked.ontologyId || !linked.linkTypeApiName || !linked.targetObjectTypeApiName) {
    throw appError("INVALID_ARGUMENT", "Linked filter requires ontologyId, linkTypeApiName, and targetObjectTypeApiName.");
  }
  const linkType = await linkTypeModel.getByApiName(linked.ontologyId, linked.linkTypeApiName);
  if (!linkType) throw appError("NOT_FOUND", `Link type '${linked.linkTypeApiName}' was not found.`);
  const linkSourceType = await resolveObjectTypeApiName(linkType.source_object_type);
  const linkTargetType = await resolveObjectTypeApiName(linkType.target_object_type);
  const direction: "forward" | "reverse" = linkSourceType === sourceObjectType ? "reverse" : "forward";
  const targetType = direction === "reverse" ? linkTargetType : linkSourceType;
  if (targetType !== linked.targetObjectTypeApiName) {
    throw appError("INVALID_ARGUMENT", `Linked filter target '${linked.targetObjectTypeApiName}' is incompatible with '${linked.linkTypeApiName}'.`);
  }

  // Multi-hop linked filters (Workshop Filter List chained linked-object
  // properties, e.g. Fraud Signal → Claim → Provider.province): the nested
  // targetWhere may itself contain `linked` predicates anchored on the
  // TARGET type. Resolve them recursively first so the validator + link
  // service only ever see plain property predicates.
  const resolvedTargetWhere = linked.targetWhere
    ? await resolveLinkedWhere(linked.targetWhere, targetType, securityFilter, branchId)
    : undefined;
  const targetWhere = resolvedTargetWhere as Record<string, unknown> | undefined;

  if (targetWhere) {
    await validateSearchQuery({ where: targetWhere, $pageSize: 1 }, targetType);
  }
  const sourcePks = new Set<string>();
  let pageToken: string | undefined;
  do {
    const resolved = await searchAround(linkType, direction, {
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
      ...(targetWhere ? { sourceWhere: targetWhere } : {}),
    }, securityFilter, branchId);
    for (const object of resolved.linkedObjects) if (object.__pk != null) sourcePks.add(String(object.__pk));
    pageToken = resolved.nextPageToken ?? undefined;
    if (sourcePks.size > 100_000) throw appError("INVALID_ARGUMENT", "Linked filter exceeds the 100,000 source safety limit; narrow the linked predicate.");
  } while (pageToken);
  // The public validator intentionally rejects empty `in` arrays. Preserve
  // match-none semantics with an impossible reserved PK sentinel instead of
  // widening an empty traversal to the complete source set.
  const predicate = { type: "in", field: "__pk", value: sourcePks.size ? Array.from(sourcePks) : ["__tellus_no_link_match__"] };
  return linked.negated ? { type: "not", value: [predicate] } : predicate;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Overlay merge helper — B7. Every search result goes through this so
 * user edits that landed in the overlay cache but haven't been indexed
 * yet become visible within the 1-second SLO. The Quickwit/OpenSearch
 * result is authoritative for everything NOT edited; for edited PKs the
 * overlay wins.
 *
 * Silently falls through to the original results if the overlay store
 * is unreachable or empty — the overlay is an optimisation, not a
 * requirement.
 */
async function mergeWithOverlay<R extends { data: unknown[] }>(
  objectType: string,
  result: R,
  whereClause?: unknown,
  branchId: string | null = null
): Promise<R> {
  // The overlay is an OPTIMISATION (recent-edit visibility within a ~1s SLO).
  // A connected-but-stuck Redis client can hang a read for tens of seconds →
  // the request-budget middleware 504s the search/list. Cap the overlay work
  // with a hard budget; on expiry, return the raw result AND degrade the
  // overlay to in-memory so subsequent reads don't queue behind the stuck
  // client. Correctness never depends on the overlay.
  const OVERLAY_BUDGET_MS = Number(process.env.OVERLAY_BUDGET_MS ?? 1_000);
  let timedOut = false;

  const run = async (): Promise<R> => {
    try {
      const store = await getOverlayStore();
      const filter = buildOverlayFilter(whereClause);
      const merged = await mergeOverlayIntoSearch({
        objectType,
        hits: result.data as Array<Record<string, unknown>>,
        filter,
        store,
        branchId,
      });
      return { ...result, data: merged } as R;
    } catch {
      // Overlay is an optimisation — on any failure we fall back to the
      // underlying result so queries never fail due to overlay issues.
      try {
        const store = await getOverlayStore();
        const replaced = await applyOverlayToResults(
          objectType,
          result.data as Array<Record<string, unknown>>,
          store,
          branchId
        );
        return { ...result, data: replaced } as R;
      } catch {
        return result;
      }
    }
  };

  try {
    return await Promise.race<R>([
      run(),
      new Promise<R>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve(result);
        }, OVERLAY_BUDGET_MS);
      }),
    ]);
  } catch {
    return result;
  } finally {
    if (timedOut) {
      try {
        markOverlayDegraded();
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Reconcile a page of indexed hits with the authoritative B1 projection.
 *
 * The writeback overlay makes newly committed actions visible immediately,
 * but it is intentionally short-lived. During a deployment/restart, or for
 * edits committed before overlay rollout, OpenSearch can still hold an older
 * document version. Returning that older version causes Workshop to submit a
 * stale OCC token even though the object has not changed since the user read
 * it. A single batched lookup closes that gap without an N+1 query pattern.
 */
async function hydrateStaleIndexedRows<R extends { data: unknown[] }>(
  objectType: string,
  result: R,
  requestedBranchId: string | null,
): Promise<R> {
  const hits = result.data.filter(
    (value): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value),
  );
  const primaryKeys = hits
    .map((hit) => hit.__pk ?? hit.__primaryKey)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (primaryKeys.length === 0) return result;

  try {
    const type = await query(
      "SELECT ontology_id FROM object_type WHERE api_name = $1 LIMIT 1",
      [objectType],
    );
    const ontologyId = type.rows[0]?.ontology_id;
    if (typeof ontologyId !== "string") return result;
    const branchId = await resolveBranchIdOrMain(ontologyId, requestedBranchId);
    const instances = await query(
      `SELECT primary_key, properties, version
         FROM object_instances
        WHERE ontology_id = $1::uuid
          AND branch_id = $2::uuid
          AND object_type_api_name = $3
          AND primary_key = ANY($4::text[])`,
      [ontologyId, branchId, objectType, [...new Set(primaryKeys)]],
    );
    const authoritative = new Map((instances.rows as Array<{
      primary_key: string;
      properties: Record<string, unknown>;
      version: number | string;
    }>).map((row) => [row.primary_key, row]));
    const data = result.data.map((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const hit = value as Record<string, unknown>;
      const primaryKey = typeof hit.__pk === "string"
        ? hit.__pk
        : typeof hit.__primaryKey === "string" ? hit.__primaryKey : null;
      const instance = primaryKey ? authoritative.get(primaryKey) : undefined;
      const indexedVersion = typeof hit.__version === "number" ? hit.__version : Number(hit.__version);
      const instanceVersion = instance ? Number(instance.version) : Number.NaN;
      if (!instance || !Number.isFinite(instanceVersion) || instanceVersion <= indexedVersion) return value;
      return {
        ...hit,
        ...instance.properties,
        __pk: instance.primary_key,
        __objectType: hit.__objectType ?? objectType,
        __version: instanceVersion,
        __overlay_source: "object_instances",
      };
    });
    return { ...result, data } as R;
  } catch {
    // Object Search remains available if a transitional deployment has not
    // created B1 tables yet; the index continues as the safe fallback.
    return result;
  }
}

/**
 * B7 SCAN discovery: build a filter predicate from the search `where`
 * clause so `collectFilterMatchingOverlays` can include overlay-only hits
 * (rows edited within the last overlay TTL that the index hasn't absorbed
 * yet).
 *
 * Contract:
 *  - UNFILTERED search (`where == null`) → match-all: every recent overlay
 *    edit for the type is merged (read-your-writes for Action-created
 *    objects inside the projection-lag window).
 *  - Supported shapes (eq / in / gt / gte / lt / lte / contains /
 *    startsWith / isNull / isNotNull + and / or / not) → precise predicate,
 *    evaluated against the EMITTED overlay doc (which carries `__pk`,
 *    `__primaryKey` and `__objectType` like an indexed hit).
 *  - Unsupported shapes → `undefined` (no extras). Conservative: the
 *    overlay REPLACEMENT path still upgrades edited rows already in the
 *    result, and dedup by PK in mergeOverlayIntoSearch keeps the index
 *    authoritative when it has caught up.
 */
function buildOverlayFilter(where: unknown): ((doc: Record<string, unknown>) => boolean) | undefined {
  // Unfiltered search: EVERY recent overlay edit for the type is a candidate
  // — this is the read-your-writes bridge that makes an Action-created object
  // visible in unfiltered object tables inside the projection-lag window
  // (OSv2 semantics), before the serving projector absorbs the edit WAL.
  if (where == null) return () => true;
  if (typeof where !== "object") return undefined;
  const w = where as Record<string, unknown>;
  const field = typeof w.field === "string" ? w.field : null;

  const coerceCompare = (docValue: unknown, filterValue: unknown): number | null => {
    // Numeric first; fall back to Date; else lexicographic string compare.
    const nA = typeof docValue === "number" ? docValue : Number(docValue);
    const nB = typeof filterValue === "number" ? filterValue : Number(filterValue);
    if (Number.isFinite(nA) && Number.isFinite(nB)) return nA - nB;
    const dA = Date.parse(String(docValue));
    const dB = Date.parse(String(filterValue));
    if (Number.isFinite(dA) && Number.isFinite(dB)) return dA - dB;
    if (docValue == null || filterValue == null) return null;
    const sA = String(docValue);
    const sB = String(filterValue);
    return sA < sB ? -1 : sA > sB ? 1 : 0;
  };

  if (field) {
    const value = w.value;
    switch (w.type) {
      case "eq":
        return (doc) => {
          const dv = doc[field];
          return dv === value || String(dv) === String(value);
        };
      case "in": {
        if (!Array.isArray(value)) return undefined;
        return (doc) =>
          value.some((v) => doc[field] === v || String(doc[field]) === String(v));
      }
      case "gt":
        return (doc) => {
          const c = coerceCompare(doc[field], value);
          return c !== null && c > 0;
        };
      case "gte":
        return (doc) => {
          const c = coerceCompare(doc[field], value);
          return c !== null && c >= 0;
        };
      case "lt":
        return (doc) => {
          const c = coerceCompare(doc[field], value);
          return c !== null && c < 0;
        };
      case "lte":
        return (doc) => {
          const c = coerceCompare(doc[field], value);
          return c !== null && c <= 0;
        };
      case "contains":
        return (doc) =>
          doc[field] != null &&
          String(doc[field]).toLowerCase().includes(String(value ?? "").toLowerCase());
      case "startsWith":
        return (doc) =>
          doc[field] != null &&
          String(doc[field]).toLowerCase().startsWith(String(value ?? "").toLowerCase());
      case "isNull":
        return (doc) => doc[field] == null;
      case "isNotNull":
        return (doc) => doc[field] != null;
      default:
        break;
    }
  }
  if (w.type === "and" && Array.isArray(w.filters)) {
    const sub = w.filters.map(buildOverlayFilter);
    // Any unsupported branch → no extras (precise-conservative: the overlay
    // REPLACEMENT path still covers edits to rows already in the result).
    if (sub.some((f) => f === undefined)) return undefined;
    const fns = sub as Array<(doc: Record<string, unknown>) => boolean>;
    if (fns.length === 0) return () => true;
    return (doc) => fns.every((f) => f(doc));
  }
  if (w.type === "or" && Array.isArray(w.filters)) {
    const sub = w.filters.map(buildOverlayFilter);
    if (sub.some((f) => f === undefined)) return undefined;
    const fns = sub as Array<(doc: Record<string, unknown>) => boolean>;
    if (fns.length === 0) return () => true;
    return (doc) => fns.some((f) => f(doc));
  }
  if (w.type === "not") {
    const sub = buildOverlayFilter(w.filter ?? w.value);
    return sub ? ((doc) => !sub(doc)) : undefined;
  }
  return undefined;
}

const KNOWN_CODES = new Set([
  "QUERY_VALIDATION_ERROR",
  "OBJECT_TYPE_NOT_FOUND",
  "PROPERTY_NOT_FOUND",
  "INCOMPATIBLE_FILTER",
  "INVALID_PAGE_TOKEN",
  "OPENSEARCH_ERROR",
  "OBJECT_NOT_FOUND",
]);

// T-07 — verbose-404 gate. Returning the full `api_name` catalog in the
// 404 body is an information-disclosure defect (H-9): an unauthenticated
// or under-privileged caller can enumerate every object type in the
// ontology by guessing one missing name. The verbose body is gated behind
// a *dual* condition so staging — which often runs `NODE_ENV=production`
// — keeps the production-shape behavior:
//   - `NODE_ENV !== "production"` AND
//   - `TELLUS_DEBUG_404 === "true"`
// In production the body says only "Object type not found.", with the
// requested name preserved as `parameters.objectType` for client log
// correlation. The hint about catalog enumeration is intentionally
// omitted from the message in production.
async function ensureObjectTypeExists(objectType: string): Promise<void> {
  const result = await query(
    "SELECT 1 FROM object_type WHERE api_name = $1",
    [objectType]
  );
  if (result.rows.length === 0) {
    const verbose =
      process.env.NODE_ENV !== "production" &&
      process.env.TELLUS_DEBUG_404 === "true";
    if (verbose) {
      const all = await query(
        "SELECT api_name FROM object_type ORDER BY api_name"
      );
      const available = all.rows.map((r: any) => r.api_name);
      throw appError(
        "OBJECT_TYPE_NOT_FOUND",
        `Object type '${objectType}' not found. Available object types: ${available.join(", ") || "(none)"}`,
        { objectType, available }
      );
    }
    throw appError(
      "OBJECT_TYPE_NOT_FOUND",
      "Object type not found.",
      { objectType }
    );
  }
}

// T-07 — Testing seam.
// `ensureObjectTypeExists` is a private function-scoped helper, but the
// verbose-404 gate (C-104) is a security-critical contract that needs a
// direct unit test without spinning up an Express app. The seam exposes
// the helper without changing its production call surface — the route
// handlers continue to use the unexported reference.
export const __internals = { ensureObjectTypeExists, buildOverlayFilter };

function handleError(err: any, res: Response, next: NextFunction) {
  if (err.code && KNOWN_CODES.has(err.code)) {
    // T-07 — fold every known-code error through the canonical envelope
    // so `errorCode`/`errorName`/`requestId` are present and `message`
    // is `sanitizeMessage`-scrubbed. `appError` historically populates
    // `details`; later additions populate `parameters`. We accept both
    // so the structured envelope carries whichever was supplied.
    const detail = err.details ?? err.parameters ?? {};
    return sendError(res, err.code, err.message, detail);
  }
  next(err);
}

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/search (MUST come before /:primaryKey)
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/search",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      // Spec §Task 23: the filter model is `{filter: [{property, operator,
      // value}, ...]}`. Translate into the historical `{where: {type,
      // field, value}}` shape (or a `{type:"and",filters:[...]}` tree for
      // multiple filters) before validation.
      const body = req.body || {};
      if (Array.isArray(body.filter) && !body.where) {
        const OP_MAP: Record<string, string> = {
          eq: "eq", ne: "eq",  // ne handled via not-wrapper below
          gt: "gt", gte: "gte", lt: "lt", lte: "lte",
          in: "in", contains: "contains", startsWith: "startsWith",
          exists: "isNotNull", notExists: "isNull",
        };
        const leaves = body.filter
          .filter((f: any) => f && f.property && f.operator)
          .map((f: any) => {
            const type = OP_MAP[f.operator as string] || "eq";
            const node: Record<string, unknown> = { type, field: f.property };
            if (type !== "isNull" && type !== "isNotNull") {
              node.value = f.value ?? f.values;
            }
            if (f.operator === "ne") {
              return { type: "not", filter: node };
            }
            return node;
          });
        if (leaves.length === 1) {
          body.where = leaves[0];
        } else if (leaves.length > 1) {
          body.where = { type: "and", filters: leaves };
        }
        delete body.filter;
      }
      // Accept the spec-style `pageSize` / `pageToken` field names.
      if (body.pageSize !== undefined && body.$pageSize === undefined) {
        body.$pageSize = body.pageSize;
        delete body.pageSize;
      }
      if (body.pageToken !== undefined && body.$pageToken === undefined) {
        body.$pageToken = body.pageToken;
        delete body.pageToken;
      }

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.search", branchId);
      body.where = await resolveLinkedWhere(body.where, objectType, secFilter, branchId);
      const validated = await validateSearchQuery(body, objectType);
      // Rwanda QA §3.3 — reject predicates on marking-restricted properties
      // and strip restricted columns from the serialized result.
      const restricted = await enforceQueryMarkings({
        objectTypeApiName: objectType,
        where: validated.where,
        orderBy: validated.$orderBy,
        security: req.security,
      });
      // EFFECTIVE-STATE FILTER prerequisite: the post-hydration re-filter
      // below evaluates the where's property leaves against the merged rows,
      // so every field the where references must survive the `_source`
      // projection. Union the where's fields into $select (the response
      // contract is unchanged — the formatter only emits the caller's
      // requested properties).
      const selectWithWhereFields =
        validated.$select && validated.$select.length > 0
          ? [...new Set([...validated.$select, ...collectWhereFields(validated.where)])]
          : validated.$select;
      const rawResult = await executeSearch(objectType, {
        where: validated.where,
        $orderBy: validated.$orderBy,
        $pageSize: validated.$pageSize,
        $pageToken: validated.$pageToken,
        $select: selectWithWhereFields,
      }, secFilter, branchId);

      // B7: merge the writeback overlay so recent edits are visible
      // before Quickwit/OpenSearch catches up. Overlay hits REPLACE
      // the index document for matching PKs; misses pass through.
      const overlayMerged = await mergeWithOverlay(objectType, rawResult, (body as Record<string, unknown>).where, branchId);
      const hydrated = await hydrateStaleIndexedRows(objectType, overlayMerged, branchId);
      // EFFECTIVE-STATE FILTER: the index-side `where` ran against the
      // lagging projection. A row whose committed edits no longer satisfy
      // the predicate must not survive into the Object Set merely because
      // its STALE index document matched (e.g. an OPEN-only queue keeping a
      // CONFIRMED signal whose status edit has not been projected yet).
      // The reverse direction (newly-matching edited rows) is covered by
      // the serving projector's drain + the overlay extras merge above.
      const result = {
        ...hydrated,
        data: refilterMergedRows(
          hydrated.data as Array<Record<string, unknown>>,
          validated.where,
        ),
      };
      stripRestrictedRows(result.data as Array<Record<string, unknown>>, req.security, restricted);

      // B9: shadow-diff during soak. Fire-and-forget — hurts neither
      // latency nor correctness if Quickwit is unreachable.
      recordShadowDiff(objectType, body, result.data as Array<Record<string, unknown>>);

      const elapsed = Date.now() - start;
      console.log(
        `[SEARCH] POST /api/v1/objects/${objectType}/search → 200 (${result.data.length}/${result.totalCount} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/searchFullText
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/searchFullText",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const { query: searchQuery, where, $orderBy, $pageSize, $pageToken, $select } =
        req.body || {};

      if (!searchQuery || typeof searchQuery !== "string" || searchQuery.trim().length === 0) {
        throw appError(
          "QUERY_VALIDATION_ERROR",
          "Search query must be a non-empty string."
        );
      }

      if (searchQuery.length > 1000) {
        throw appError(
          "QUERY_VALIDATION_ERROR",
          "Search query exceeds maximum length of 1000 characters."
        );
      }

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.searchFullText", branchId);
      const restricted = await enforceQueryMarkings({
        objectTypeApiName: objectType,
        where,
        orderBy: $orderBy,
        security: req.security,
      });
      const rawResult = await executeFullTextSearch(objectType, searchQuery.trim(), {
        where,
        $orderBy,
        $pageSize: $pageSize ?? 100,
        $pageToken,
        $select,
      }, secFilter, branchId);
      // B7: overlay merge for immediate edit visibility.
      const result = await mergeWithOverlay(objectType, rawResult, undefined, branchId);
      stripRestrictedRows(result.data as Array<Record<string, unknown>>, req.security, restricted);

      const elapsed = Date.now() - start;
      console.log(
        `[FULLTEXT] POST /api/v1/objects/${objectType}/searchFullText → 200 (${result.data.length}/${result.totalCount} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/aggregate
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/aggregate",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.aggregate", branchId);
      const aggregateBody = { ...(req.body || {}) };
      aggregateBody.where = await resolveLinkedWhere(aggregateBody.where, objectType, secFilter, branchId);
      const validated = await validateAggregateQuery(aggregateBody, objectType);
      // Rwanda QA §3.3 — aggregates never include restricted properties.
      await enforceQueryMarkings({
        objectTypeApiName: objectType,
        where: validated.where,
        aggregations: validated.aggregations,
        security: req.security,
      });
      // EFFECTIVE-STATE AGGREGATION: when the type has committed edits the
      // serving projector has not drained yet, index buckets reflect the
      // lagging projection (e.g. a KPI counting OPEN signals still includes
      // a just-CONFIRMED one). Recompute over the authoritative store so the
      // response matches the same effective objects search returns. Bounded:
      // beyond RECONCILE_MAX_CANDIDATES the (seconds-to-converge) index
      // answer is returned instead of materializing the set.
      let result: Record<string, unknown>;
      if (await hasServingPendingEdits(objectType)) {
        result = await executeAggregate(objectType, {
          where: validated.where,
          aggregations: validated.aggregations,
        }, secFilter, branchId);
        try {
          const candidates = await executeSearch(objectType, {
            where: validated.where,
            $pageSize: RECONCILE_MAX_CANDIDATES,
          }, secFilter, branchId);
          const total = typeof candidates.totalCount === "number" ? candidates.totalCount : candidates.data.length;
          if (total <= RECONCILE_MAX_CANDIDATES) {
            const hydrated = await hydrateStaleIndexedRows(objectType, candidates, branchId);
            const effectiveRows = refilterMergedRows(
              hydrated.data as Array<Record<string, unknown>>,
              validated.where,
            );
            result = recomputeAggregationsOverRows(
              effectiveRows,
              validated.aggregations,
            );
          }
        } catch (reconcileErr) {
          console.warn(
            `[AGGREGATE] effective-state reconcile skipped for ${objectType}: ${(reconcileErr as Error).message}`,
          );
        }
      } else {
        result = await executeAggregate(objectType, {
          where: validated.where,
          aggregations: validated.aggregations,
        }, secFilter, branchId);
      }

      const elapsed = Date.now() - start;
      console.log(
        `[AGGREGATE] POST /api/v1/objects/${objectType}/aggregate → 200 (${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/objects/:objectType (List Objects)
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/objects/:objectType",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const validated = await validateListQuery(
        req.query as Record<string, any>,
        objectType
      );

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.list", branchId);
      // Rwanda QA §3.3 — sort/select on restricted properties is rejected.
      const restricted = await enforceQueryMarkings({
        objectTypeApiName: objectType,
        orderBy: validated.orderBy,
        security: req.security,
      });
      const rawResult = await executeSearch(objectType, {
        $orderBy: validated.orderBy.length > 0 ? validated.orderBy : undefined,
        $pageSize: validated.pageSize,
        $pageToken: validated.pageToken,
        $select: validated.select,
      }, secFilter, branchId);
      // B7: overlay merge — recent edits visible within 1s.
      const result = await mergeWithOverlay(objectType, rawResult, undefined, branchId);
      stripRestrictedRows(result.data as Array<Record<string, unknown>>, req.security, restricted);

      const elapsed = Date.now() - start;
      console.log(
        `[LIST] GET /api/v1/objects/${objectType} → 200 (${result.data.length}/${result.totalCount} objects, ${elapsed}ms)`
      );

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/searchAround (Task 13-14)
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/searchAround",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const { linkType: linkTypeApiName, direction, sourceFilter, targetFilter, pageSize, pageToken, $direction } = req.body;

      if (!linkTypeApiName) {
        throw appError("QUERY_VALIDATION_ERROR", "linkType is required in request body.");
      }
      if (!direction && !$direction) {
        throw appError("QUERY_VALIDATION_ERROR", "direction is required.");
      }

      // Find the link type — need ontology for this object type
      const otResult = await query(
        "SELECT ontology_id FROM object_type WHERE api_name = $1",
        [objectType]
      );
      if (otResult.rows.length === 0) {
        throw appError("OBJECT_TYPE_NOT_FOUND", `Object type '${objectType}' not found.`);
      }
      const ontologyId = otResult.rows[0].ontology_id;

      const linkType = await linkTypeModel.getByApiName(ontologyId, linkTypeApiName);
      if (!linkType) {
        throw appError("LINK_TYPE_NOT_FOUND", `Link type '${linkTypeApiName}' not found.`);
      }

      const effectiveDirection = (direction || $direction) as "forward" | "reverse";
      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.searchAround", branchId);
      const searchOptions: import("../services/linkResolverService").SearchAroundOptions = {
        sourceFilter, targetFilter, pageSize, pageToken,
      };
      if (linkType.cardinality === "MANY_TO_MANY") {
        // Serving-store cutover: per-scope rollout flag routes M2M edge
        // resolution through the versioned index (shadow/indexed modes).
        const { maybeServingEdgeResolver } = await import(
          "../services/serving/linkServingStore"
        );
        const { resolveRequestTenant } = await import("../utils/requestTenant");
        const edgeResolver = await maybeServingEdgeResolver({
          linkType,
          direction: effectiveDirection,
          branchId,
          userMarkings: new Set(req.security?.markings ?? []),
          tenantId: resolveRequestTenant(req),
          capability: "objects.searchAround",
        });
        if (edgeResolver) searchOptions.edgeResolver = edgeResolver;
      }
      const result = await searchAround(linkType, effectiveDirection, searchOptions, secFilter, branchId);

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/:primaryKey/searchAround/:linkApiName
//
// RESTful per-object link traversal — the shape the frontend's
// `searchAround(fromApiName, pk, linkApiName, …)` client calls. It
// resolves the link type from the URL, derives the traversal direction
// from which side `:objectType` sits on, scopes the source to the single
// object by primary key, and delegates to the same `searchAround`
// service the body-style route uses. Request body mirrors the regular
// `/search` route's `$`-prefixed fields: `$pageSize`, `$pageToken`,
// `where` (target filter), `$orderBy`. Response is `{ data,
// nextPageToken, totalCount }` to match the FE's link/search contract.
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/:primaryKey/searchAround/:linkApiName",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectType, primaryKey, linkApiName } = req.params;
      await ensureObjectTypeExists(objectType);

      const otResult = await query(
        "SELECT object_type_id, ontology_id FROM object_type WHERE api_name = $1",
        [objectType]
      );
      if (otResult.rows.length === 0) {
        throw appError("OBJECT_TYPE_NOT_FOUND", `Object type '${objectType}' not found.`);
      }
      const { object_type_id, ontology_id } = otResult.rows[0];

      const linkType = await linkTypeModel.getByApiName(ontology_id, linkApiName);
      if (!linkType) {
        throw appError("LINK_TYPE_NOT_FOUND", `Link type '${linkApiName}' not found.`);
      }

      // Direction: forward when this object type is the link's source side,
      // reverse when it's the target side.
      const direction: "forward" | "reverse" =
        linkType.source_object_type === object_type_id ? "forward" : "reverse";

      const { $pageSize, $pageToken, where, $orderBy } = req.body ?? {};
      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req);
      routeMetric(req, "objects.searchAround", branchId);

      let edgeResolver:
        | import("../services/linkResolverService").SearchAroundOptions["edgeResolver"]
        | undefined;
      if (linkType.cardinality === "MANY_TO_MANY") {
        const { maybeServingEdgeResolver } = await import(
          "../services/serving/linkServingStore"
        );
        const { resolveRequestTenant } = await import("../utils/requestTenant");
        edgeResolver = await maybeServingEdgeResolver({
          linkType,
          direction,
          branchId,
          userMarkings: new Set(req.security?.markings ?? []),
          tenantId: resolveRequestTenant(req),
          capability: "objects.searchAround",
        });
      }

      const result = await searchAround(
        linkType,
        direction,
        {
          sourceFilter: { __pk: primaryKey },
          targetFilter: where,
          pageSize: $pageSize,
          pageToken: $pageToken,
          orderBy: $orderBy,
          edgeResolver,
        },
        secFilter,
        branchId
      );

      // Foundry parity: every linked row must carry the target object's
      // primary key under `__pk`/`__primaryKey` so clients can chain
      // further traversals and correlate rows. Some index projections
      // (dataset-backed object types) store the PK only under its property
      // apiName; normalize here rather than forcing every consumer to know
      // each type's PK property.
      const targetObjectTypeId =
        direction === "forward"
          ? linkType.target_object_type
          : linkType.source_object_type;
      const pkResult = await query(
        `SELECT p.api_name
           FROM object_type ot
           JOIN property p ON p.property_id = ot.primary_key_property_id
          WHERE ot.object_type_id = $1`,
        [targetObjectTypeId]
      );
      const pkApiName: string | undefined = pkResult.rows[0]?.api_name;
      const linkedObjects = pkApiName
        ? result.linkedObjects.map((o) => {
            if (o.__pk != null && o.__primaryKey != null) return o;
            const pk = o.__pk ?? o.__primaryKey ?? o[pkApiName];
            if (pk == null) return o;
            return {
              ...o,
              __pk: o.__pk ?? String(pk),
              __primaryKey: o.__primaryKey ?? String(pk),
            };
          })
        : result.linkedObjects;

      return sendSuccess(res, {
        data: linkedObjects,
        nextPageToken: result.nextPageToken,
        totalCount: result.totalCount,
      });
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/v1/objects/:objectType/validateForeignKeys (Task 20)
// ---------------------------------------------------------------------------

router.post(
  "/api/v1/objects/:objectType/validateForeignKeys",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectType } = req.params;
      await ensureObjectTypeExists(objectType);

      const otResult = await query(
        "SELECT object_type_id, ontology_id FROM object_type WHERE api_name = $1",
        [objectType]
      );
      const { object_type_id, ontology_id } = otResult.rows[0];

      // F-P3-13: FK validation scoped to the caller's branch.
      const branchId = readBranchHeader(req);
      routeMetric(req, "objects.validateForeignKeys", branchId);
      const result = await validateForeignKeys(object_type_id, req.body, ontology_id, buildSecurityFilter(req.security), branchId);
      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/objects/:objectType/:primaryKey/links/:linkType (Task 12)
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/objects/:objectType/:primaryKey/links/:linkType",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectType, primaryKey, linkType: linkTypeApiName } = req.params;
      const { direction, pageSize, pageToken, select } = req.query;

      await ensureObjectTypeExists(objectType);

      // Resolve ontology
      const otResult = await query(
        "SELECT object_type_id, ontology_id FROM object_type WHERE api_name = $1",
        [objectType]
      );
      if (otResult.rows.length === 0) {
        throw appError("OBJECT_TYPE_NOT_FOUND", `Object type '${objectType}' not found.`);
      }
      const { object_type_id, ontology_id } = otResult.rows[0];

      const linkType = await linkTypeModel.getByApiName(ontology_id, linkTypeApiName);
      if (!linkType) {
        throw appError("LINK_TYPE_NOT_FOUND", `Link type '${linkTypeApiName}' not found.`);
      }

      // Determine direction: if not explicit, infer from object type position
      let effectiveDirection: "forward" | "reverse" = "forward";
      if (direction) {
        effectiveDirection = direction as "forward" | "reverse";
      } else if (linkType.target_object_type === object_type_id && linkType.source_object_type !== object_type_id) {
        effectiveDirection = "reverse";
      }

      const secFilter = buildSecurityFilter(req.security);
      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.linked", branchId);
      const result = await resolveLinks(linkType, primaryKey, effectiveDirection, {
        pageSize: pageSize ? parseInt(pageSize as string, 10) : undefined,
        pageToken: pageToken as string,
        select: select ? (select as string).split(",") : undefined,
      }, secFilter, branchId);

      // Format based on cardinality
      const isSingle = (
        (linkType.cardinality === "ONE_TO_ONE") ||
        (linkType.cardinality === "MANY_TO_ONE" && effectiveDirection === "forward")
      );

      if (isSingle) {
        return sendSuccess(res, {
          linkedObject: result.linkedObjects.length > 0 ? result.linkedObjects[0] : null,
        });
      }

      return sendSuccess(res, result);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/objects/:objectType/:primaryKey/links/:linkType/count (Task 15)
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/objects/:objectType/:primaryKey/links/:linkType/count",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { objectType, primaryKey, linkType: linkTypeApiName } = req.params;
      const { direction } = req.query;

      await ensureObjectTypeExists(objectType);

      const otResult = await query(
        "SELECT object_type_id, ontology_id FROM object_type WHERE api_name = $1",
        [objectType]
      );
      const { object_type_id, ontology_id } = otResult.rows[0];

      const linkType = await linkTypeModel.getByApiName(ontology_id, linkTypeApiName);
      if (!linkType) {
        throw appError("LINK_TYPE_NOT_FOUND", `Link type '${linkTypeApiName}' not found.`);
      }

      let effectiveDirection: "forward" | "reverse" = "forward";
      if (direction) {
        effectiveDirection = direction as "forward" | "reverse";
      } else if (linkType.target_object_type === object_type_id && linkType.source_object_type !== object_type_id) {
        effectiveDirection = "reverse";
      }

      // F-P3-13: link count scoped to the caller's branch.
      const branchId = readBranchHeader(req);
      routeMetric(req, "objects.linkedCount", branchId);
      const count = await countLinks(linkType, primaryKey, effectiveDirection, buildSecurityFilter(req.security), branchId);
      return sendSuccess(res, { linkTypeApiName, direction: effectiveDirection, count });
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/objects/:objectType/:primaryKey/editHistory (Task 17)
//
// Returns the complete edit history for a single object in reverse
// chronological order (most recent first). Each entry shows what operation
// was performed, what properties were changed, who made the change, and
// when. Essential for audit and compliance — a tax auditor must be able to
// see every change ever made to a taxpayer record.
//
// Query parameters:
//   $pageSize  — integer, default 50, max 500
//   $pageToken — base64-encoded cursor (executed_at of last item on prev page)
//   startTime  — ISO timestamp, only edits on or after this time
//   endTime    — ISO timestamp, only edits on or before this time
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/objects/:objectType/:primaryKey/editHistory",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType, primaryKey } = req.params;
      await ensureObjectTypeExists(objectType);

      // CWE-639 remediation: editHistory returns full property_values from
      // the audit table — content identical in sensitivity to the object
      // itself. Gate on parent-object visibility BEFORE touching
      // ontology_edit: the same security-filtered read used by GET-single
      // (executeGetObject re-issues the fetch as a filtered search and
      // returns null when the caller's markings don't match). An invisible
      // (marking-restricted or missing) object yields the same 404 as a
      // nonexistent one, so this endpoint can neither confirm existence
      // nor leak content of restricted objects.
      const branchId = readBranchHeader(req);
      routeMetric(req, "objects.editHistory", branchId);
      const parentObject = await executeGetObject(
        objectType,
        primaryKey,
        buildSecurityFilter(req.security),
        branchId
      );
      if (!parentObject) {
        throw appError(
          "OBJECT_NOT_FOUND",
          `Object with primary key '${primaryKey}' not found in object type '${objectType}'.`
        );
      }

      // ------------------------------------------------------------------
      // Parse and validate query parameters
      // ------------------------------------------------------------------

      const rawPageSize = req.query.$pageSize ?? req.query.pageSize;
      let pageSize = 50;
      if (rawPageSize !== undefined) {
        pageSize = parseInt(String(rawPageSize), 10);
        if (isNaN(pageSize) || pageSize < 1) {
          throw appError(
            "QUERY_VALIDATION_ERROR",
            "$pageSize must be a positive integer."
          );
        }
        if (pageSize > 500) {
          throw appError(
            "QUERY_VALIDATION_ERROR",
            "$pageSize must not exceed 500."
          );
        }
      }

      const rawPageToken = req.query.$pageToken ?? req.query.pageToken;
      let cursorTimestamp: string | null = null;
      let cursorEditId: string | null = null;
      if (rawPageToken !== undefined && rawPageToken !== "") {
        try {
          const decoded = Buffer.from(String(rawPageToken), "base64").toString();
          // Composite cursor format: "timestamp::edit_id"
          // Legacy format (timestamp only) is also accepted for backward compat.
          const separatorIdx = decoded.indexOf("::");
          if (separatorIdx !== -1) {
            cursorTimestamp = decoded.substring(0, separatorIdx);
            cursorEditId = decoded.substring(separatorIdx + 2);
          } else {
            // Legacy format: timestamp only
            cursorTimestamp = decoded;
          }
          const parsed = new Date(cursorTimestamp);
          if (isNaN(parsed.getTime())) {
            throw new Error("Invalid date");
          }
        } catch {
          throw appError(
            "INVALID_PAGE_TOKEN",
            "Invalid $pageToken. Must be a valid base64-encoded cursor."
          );
        }
      }

      const startTime =
        req.query.startTime !== undefined && req.query.startTime !== ""
          ? String(req.query.startTime)
          : null;
      const endTime =
        req.query.endTime !== undefined && req.query.endTime !== ""
          ? String(req.query.endTime)
          : null;

      // Validate startTime/endTime are valid ISO timestamps if provided
      if (startTime !== null && isNaN(new Date(startTime).getTime())) {
        throw appError(
          "QUERY_VALIDATION_ERROR",
          "startTime must be a valid ISO 8601 timestamp."
        );
      }
      if (endTime !== null && isNaN(new Date(endTime).getTime())) {
        throw appError(
          "QUERY_VALIDATION_ERROR",
          "endTime must be a valid ISO 8601 timestamp."
        );
      }

      // ------------------------------------------------------------------
      // Query: Total count (with same WHERE filters, no LIMIT)
      // ------------------------------------------------------------------

      const countResult = await query(
        `SELECT COUNT(*)::int AS total
         FROM ontology_edit
         WHERE object_type_api_name = $1
           AND primary_key = $2
           AND ($3::timestamptz IS NULL OR executed_at >= $3)
           AND ($4::timestamptz IS NULL OR executed_at <= $4)`,
        [objectType, primaryKey, startTime, endTime]
      );
      const totalCount: number = countResult.rows[0].total;

      // ------------------------------------------------------------------
      // Query: Edit history page with LEFT JOIN to audit log
      //
      // The LEFT JOIN on execution_id fetches the action display name and
      // execution result from the audit log, so the response includes
      // richer context about the action that produced each edit.
      // ------------------------------------------------------------------

      // Composite cursor pagination: use (executed_at, edit_id) to avoid
      // duplicates or skips when multiple edits share the same timestamp
      // (possible within a single PG transaction).
      const editsResult = await query(
        `SELECT
           e.edit_id,
           e.object_type_api_name,
           e.primary_key,
           e.operation,
           e.property_values,
           e.link_edits,
           e.action_type_api_name,
           e.execution_id,
           e.action_parameters,
           e.executed_by,
           e.executed_at,
           e.indexed,
           e.indexed_at,
           a.action_type_display_name,
           a.result AS execution_result
         FROM ontology_edit e
         LEFT JOIN action_audit_log a ON e.execution_id = a.execution_id
         WHERE e.object_type_api_name = $1
           AND e.primary_key = $2
           AND ($3::timestamptz IS NULL OR e.executed_at >= $3)
           AND ($4::timestamptz IS NULL OR e.executed_at <= $4)
           AND (
             $5::timestamptz IS NULL
             OR e.executed_at < $5
             OR (e.executed_at = $5 AND $6::uuid IS NOT NULL AND e.edit_id < $6::uuid)
           )
         ORDER BY e.executed_at DESC, e.edit_id DESC
         LIMIT $7`,
        [objectType, primaryKey, startTime, endTime, cursorTimestamp, cursorEditId, pageSize]
      );

      const rows = editsResult.rows;

      // ------------------------------------------------------------------
      // Format response
      //
      // TODO: For update operations, compute a full "before vs. after" diff
      // by comparing property_values with the object state before the edit.
      // For week 1 we just show what was SET (property_values from the edit).
      // ------------------------------------------------------------------

      const data = rows.map((row: Record<string, unknown>) => ({
        editId: row.edit_id,
        operation: row.operation,
        propertyValues: row.property_values ?? {},
        linkEdits: row.link_edits ?? [],
        actionTypeApiName: row.action_type_api_name ?? null,
        actionTypeDisplayName: row.action_type_display_name ?? null,
        executionId: row.execution_id ?? null,
        executionResult: row.execution_result ?? null,
        actionParameters: row.action_parameters ?? {},
        executedBy: row.executed_by,
        executedAt: row.executed_at,
        indexed: row.indexed,
        indexedAt: row.indexed_at ?? null,
      }));

      // ------------------------------------------------------------------
      // Build next page token
      //
      // If we got a full page of results, there might be more. Encode a
      // composite cursor "executed_at::edit_id" so pagination is stable
      // even when multiple edits share the same timestamp.
      // ------------------------------------------------------------------

      let nextPageToken: string | null = null;
      if (rows.length === pageSize) {
        const lastRow = rows[rows.length - 1];
        const cursor = `${String(lastRow.executed_at)}::${String(lastRow.edit_id)}`;
        nextPageToken = Buffer.from(cursor).toString("base64");
      }

      const elapsed = Date.now() - start;
      console.log(
        `[EDIT_HISTORY] GET /api/v1/objects/${objectType}/${primaryKey}/editHistory → 200 (${data.length}/${totalCount} edits, ${elapsed}ms)`
      );

      return sendSuccess(res, {
        objectType,
        primaryKey,
        data,
        nextPageToken,
        totalCount,
      });
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

// ---------------------------------------------------------------------------
// GET /api/v1/objects/:objectType/:primaryKey (Single Object)
// ---------------------------------------------------------------------------

router.get(
  "/api/v1/objects/:objectType/:primaryKey",
  async (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    try {
      const { objectType, primaryKey } = req.params;
      await ensureObjectTypeExists(objectType);

      const branchId = readBranchHeader(req); // F-P3-13
      routeMetric(req, "objects.get", branchId);

      // Stage-5 slice #1: object GET routed through objects.get rollout —
      // the state-of-shape difference between modes is preserved.
      const ontologyIdResult = await query(
        "SELECT ontology_id FROM object_type WHERE api_name = $1",
        [objectType],
      );
      const ontologyId = ontologyIdResult.rows[0] ? String(ontologyIdResult.rows[0].ontology_id) : "00000000-0000-0000-0000-000000000001";
      const { resolveRequestTenant } = await import("../utils/requestTenant");
      const { objectServingStoreGet } = await import("../services/serving/objectServingStore");
      let obj = await objectServingStoreGet(
        {
          objectTypeApiName: objectType,
          primaryKey,
          scope: {
            tenantId: resolveRequestTenant(req),
            ontologyId,
            branchId: branchId ?? "",
          },
        },
        // PG-hydrated doc wins when present; objects that were indexed
        // BEFORE their funnel hydration committed (or through the legacy
        // standalone index trigger, which never hydrates object_instances)
        // fall back to the serving index so pre-cutover reads keep working.
        //
        // REGRESSION FIX (CI-only GET-single 404): pgObjectAsDoc() returns a
        // PROMISE — the previous `(await import(...)).pgObjectAsDoc(...) ??
        // executeGetObject(...)` form tested the promise object itself,
        // which is always non-nullish, so the `??` short-circuited and the
        // OS-index fallback NEVER ran. Any object not hydrated into
        // object_instances (funnel down, e.g. CI) then 404'd even though the
        // serving index had the doc. Await both sides explicitly.
        async (ot, pk) =>
          // CWE-639 remediation (Strix): the PG doc path previously won
          // without any marking check. Pass the caller's security context
          // so pgObjectAsDoc enforces the same conjunctive marking rule as
          // executeGetObject; a restricted row now returns null here and
          // the object 404s below instead of leaking.
          await (await import("../services/serving/pgObjectAsDoc")).pgObjectAsDoc(
            ontologyId, ot, pk,
            req.security
              ? { markings: req.security.markings, markingBypass: req.security.markingBypass ?? req.security.systemPrincipal }
              : { markings: [] },
          )
          ?? await executeGetObject(ot, pk, buildSecurityFilter(req.security), branchId),
        async (args) => executeGetObject(args.objectTypeApiName, args.primaryKey, buildSecurityFilter(req.security), branchId),
      );

      // B7: overlay read — if a recent edit is in the overlay but the
      // index hasn't absorbed it yet, the overlay is authoritative for
      // this PK.
      //
      // Two paths, kept distinct to avoid the "synthetic-stub" bug:
      //   1. Index HIT  → merge any overlay entry onto the real doc.
      //   2. Index MISS → do an explicit overlay lookup. Only
      //      materialise an object when the overlay ACTUALLY has a
      //      record for this PK. Do NOT pass a `{__pk}` placeholder
      //      through `applyOverlayToResults` — when the overlay is
      //      empty it returns the placeholder unchanged, the caller
      //      treats it as a hit, and every GET of a missing PK
      //      returns 200 with a stub document (fails the spec §Task 28
      //      IDOR guard and the GET-single 404 test).
      try {
        const store = await getOverlayStore();
        if (obj) {
          const overlayed = await applyOverlayToResults(
            objectType,
            [obj as Record<string, unknown>],
            store,
            branchId
          );
          // `applyOverlayToResults` returns an EMPTY array when the
          // overlay says the row is deleted → drop obj so the 404
          // branch below fires.
          obj = (overlayed[0] as typeof obj) ?? null;
        } else {
          // T-04: route the index-miss path through `readOverlay` so the
          // legacy-fallback gate and branch-mismatch counter fire.
          const record = await readOverlay(branchId, objectType, primaryKey, store);
          if (record && !record.deleted) {
            // `obj`'s static type is whatever `executeGetObject` returns;
            // cast via `unknown` because the overlay record's shape is a
            // plain property map — structurally compatible at runtime,
            // but TS can't prove it.
            obj = ({
              ...record.doc,
              __pk: record.primaryKey,
              __version: record.version,
              __overlay_source: "writeback",
            } as unknown) as typeof obj;
          }
        }
      } catch {
        /* overlay optional */
      }


      if (!obj || (obj as { __deleted?: boolean }).__deleted) {
        // Spec §Task 28: return 404 (not 403) for unauthorised/missing
        // lookups to prevent IDOR information leakage.
        throw appError(
          "OBJECT_NOT_FOUND",
          `Object with primary key '${primaryKey}' not found in object type '${objectType}'.`
        );
      }

      // Spec §Task 28 column-level stripping: remove any property the
      // caller lacks a matching marking for. Property markings are read
      // from the `property.marking_required` column — a null value means
      // the property is public.
      try {
        const propResult = await query(
          `SELECT api_name, marking_required FROM property
             WHERE object_type_id = (SELECT object_type_id FROM object_type WHERE api_name = $1)
               AND marking_required IS NOT NULL`,
          [objectType]
        );
        if (propResult.rows.length > 0) {
          const security = (req as any).security;
          const userMarkings = new Set((security?.markings as string[]) || []);
          const nestedProperties = (obj as { properties?: Record<string, unknown> }).properties;
          const properties = nestedProperties && typeof nestedProperties === "object"
            ? nestedProperties
            : (obj as Record<string, unknown>);
          if (properties) {
            omitUnauthorizedProperties(
              properties,
              propResult.rows as PropertyMarking[],
              userMarkings,
              security?.markingBypass === true,
            );
          }
        }
      } catch {
        // property.marking_required may not exist on every schema — skip.
      }

      // FOUNDRY-GAPS §8 cell-level marking redaction (migration 102). Runs
      // AFTER column-level stripping: any property the column strip left in
      // place may still carry a per-cell marking on THIS object. We redact the
      // value to null when the caller doesn't hold a superset of the cell's
      // markings. Guarded + best-effort: a markingBypass principal skips it,
      // and a missing object_cell_marking table (pre-102 schema) is a no-op.
      try {
        const sec = (req as any).security;
        const properties = (obj as { properties?: Record<string, unknown> }).properties;
        if (properties && !sec?.markingBypass) {
          const cellMarks = await cellMarkingService.getForObject(objectType, primaryKey);
          if (Object.keys(cellMarks).length > 0) {
            const redacted = redactCells(properties, cellMarks, {
              userMarkings: (sec?.markings as string[]) || [],
              markingBypass: Boolean(sec?.markingBypass),
            });
            if (redacted.length > 0) {
              (obj as { __redactedCells?: string[] }).__redactedCells = redacted;
            }
          }
        }
      } catch {
        // object_cell_marking may not exist yet — cell markings are optional.
      }

      const elapsed = Date.now() - start;
      console.log(
        `[GET] GET /api/v1/objects/${objectType}/${primaryKey} → 200 (${elapsed}ms)`
      );

      return sendSuccess(res, obj);
    } catch (err: any) {
      return handleError(err, res, next);
    }
  }
);

export default router;
