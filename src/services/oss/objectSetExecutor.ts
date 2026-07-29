// ---------------------------------------------------------------------------
// ObjectSet executor (Phase 4) — fulfils compiled plans against the
// EXISTING infrastructure. No second query engine: filters go
// through queryTranslator, security through the single
// applyContext choke point, edits through the overlay, links
// through searchAroundService.
//
// Dependencies are narrow interfaces so the whole executor is
// unit-testable with fakes.
// ---------------------------------------------------------------------------

import type { CompiledObjectSet, CompiledPlan } from "./objectSetCompiler";
import type {
  LoadObjectSetRequestV2,
  AggregateObjectSetRequestV2,
  PropertyIdentifier,
} from "./objectSetDefinition";
import {
  MAX_GROUP_COUNT,
  objectSetFingerprint,
} from "./objectSetDefinition";
import {
  buildCompositeV2Aggs,
  buildV2Aggs,
  parseCompositeV2Page,
  parseV2AggResponse,
  assertAccuracy,
  supportsCompositeGrouping,
} from "./aggregationV2";
import { createPageTokenV2, decodePageTokenV2 } from "./pageTokenV2";
import { deterministicObjectRid } from "../objectIdentity";

// ---------------------------------------------------------------------------
// Errors (v2 names — mapped to HTTP by the route layer)
// ---------------------------------------------------------------------------

export class ObjectSetExecutionError extends Error {
  constructor(
    public readonly errorName: string,
    message: string,
    public readonly parameters: Record<string, unknown> = {},
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = "ObjectSetExecutionError";
  }
}

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

export interface OsSearchResponse {
  hits: Array<{
    _id: string;
    _source: Record<string, unknown>;
    _sort?: unknown[];
    _score?: number | null;
  }>;
  total: number;
  aggregations?: Record<string, unknown>;
}

export interface ExecutorDeps {
  /** Fail closed before a property can influence filters, ordering or aggs. */
  authorizeProperties?: (
    objectType: string,
    fields: string[],
    usage: "filter" | "order" | "aggregation" | "knn",
  ) => Promise<void>;
  /** property apiName → OS keyword field (bucketing). */
  keywordOf: (objectType: string, field: string) => Promise<string>;
  /** internal where-DSL → OpenSearch query clause. */
  translateWhere: (objectType: string, where: unknown) => Promise<Record<string, unknown>>;
  /** Execute ONE search. Security+branch MUST already be injected
   *  by the factory that builds this dep (single choke point). */
  search: (
    objectType: string,
    body: Record<string, unknown>,
    options?: { pitId?: string },
  ) => Promise<OsSearchResponse>;
  /** Snapshot preflight: fail unless every visible overlay edit is indexed. */
  assertSnapshotReady?: (objectTypes: string[]) => Promise<void>;
  /** Open one OpenSearch point-in-time per concrete Object Type. */
  createPointInTime?: (
    objectTypes: string[],
  ) => Promise<Record<string, string>>;
  /** Best-effort release of point-in-time contexts. */
  closePointInTime?: (pitIds: Record<string, string>) => Promise<void>;
  /** Merge overlay (writeback) hits; null when snapshot disabled. */
  mergeOverlay?: (
    objectType: string,
    hits: Array<Record<string, unknown>>,
    where: unknown,
  ) => Promise<Array<Record<string, unknown>>>;
  /** searchAround traversal: anchor PKs → target PKs + target type. */
  traverse?: (opts: {
    fromObjectType: string;
    link: string;
    anchorWhere: unknown;
    interfaceLink?: boolean;
  }) => Promise<
    | { targetObjectType: string; targetPks: string[] }
    | Array<{ targetObjectType: string; targetPks: string[] }>
  >;
  /** Resolve static rids → (objectType, primaryKey). */
  resolveStaticRids?: (
    rids: string[],
  ) => Promise<Array<{ rid: string; objectType: string; primaryKey: string }>>;
  /** Metadata required for exact select/selectV2 response shaping. */
  getSelectionMetadata?: (
    objectType: string,
  ) => Promise<ObjectTypeSelectionMetadata>;
  /**
   * Apply property/cell authorization to fully composed objects. This runs
   * after transaction/scenario/writeback composition and before derived
   * properties, preventing derived expressions from becoming a side channel.
   * Authorized marked values carry an internal descriptor which is converted
   * to the public SecuredPropertyValue/PropertySecurities representation only
   * when loadPropertySecurities=true.
   */
  secureProperties?: (
    objectType: string,
    hits: Array<Record<string, unknown>>,
  ) => Promise<Array<Record<string, unknown>>>;
  signMediaReferences?: (
    objectType: string,
    hits: Array<Record<string, unknown>>,
  ) => Promise<Array<Record<string, unknown>>>;
  resolveKnnVector?: (
    objectType: string,
    field: string,
    query:
      | { type: "vector"; value: number[] }
      | { type: "text"; value: string },
  ) => Promise<number[]>;
  /** Compose scenario then transaction edits over the secured base query. */
  composeReadContext?: (
    objectType: string,
    hits: Array<Record<string, unknown>>,
    where: unknown,
    versions: {
      transactionVersion: number | null;
      scenarioVersion: number | null;
    },
  ) => Promise<Array<Record<string, unknown>>>;
  adjustReadContextTotal?: (
    objectType: string,
    baseTotal: number,
    where: unknown,
    versions: {
      transactionVersion: number | null;
      scenarioVersion: number | null;
    },
  ) => Promise<number>;
}

export interface ExecutionContext {
  ontologyRid: string;
  branchRid: string | null;
  tenant: string;
  /** Authenticated principal and authorization-state binding for page tokens. */
  userId?: string;
  securityFingerprint?: string;
  transactionId: string | null;
  transactionVersion?: number | null;
  scenarioRid: string | null;
  scenarioVersion?: number | null;
  /** snapshot: true → overlay failures are typed errors, never
   *  a silent fall-through to stale results (Phase 8). */
  snapshot: boolean;
}

export interface ObjectTypeSelectionMetadata {
  primaryKeyPropertyApiName: string | null;
  titlePropertyApiName: string | null;
  properties: Record<
    string,
    {
      baseType: string;
      structSchema?: Array<{ name: string; type?: string }> | null;
      reducerConfig?: { type?: string } | null;
      structMainValueField?: string | null;
    }
  >;
}

// ---------------------------------------------------------------------------
// Derived properties (withProperties node)
// ---------------------------------------------------------------------------

export function evaluateDerivedProperty(
  expr: unknown,
  obj: Record<string, unknown>,
): unknown {
  if (!expr || typeof expr !== "object") return null;
  const e = expr as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  switch (e.type) {
    case "getSelectedProperty":
      return obj[e.apiName as string] ?? null;
    case "add": {
      let acc = 0;
      for (const p of e.properties as unknown[]) {
        const v = num(evaluateDerivedProperty(p, obj));
        if (v === null) return null;
        acc += v;
      }
      return acc;
    }
    case "subtract": {
      const l = num(evaluateDerivedProperty(e.left, obj));
      const r = num(evaluateDerivedProperty(e.right, obj));
      return l === null || r === null ? null : l - r;
    }
    case "multiply": {
      let acc = 1;
      for (const p of e.properties as unknown[]) {
        const v = num(evaluateDerivedProperty(p, obj));
        if (v === null) return null;
        acc *= v;
      }
      return acc;
    }
    case "divide": {
      const l = num(evaluateDerivedProperty(e.left, obj));
      const r = num(evaluateDerivedProperty(e.right, obj));
      return l === null || r === null || r === 0 ? null : l / r;
    }
    case "negate": {
      const v = num(evaluateDerivedProperty(e.property, obj));
      return v === null ? null : -v;
    }
    case "absoluteValue": {
      const v = num(evaluateDerivedProperty(e.property, obj));
      return v === null ? null : Math.abs(v);
    }
    default:
      throw new ObjectSetExecutionError(
        "UnsupportedDerivedProperty",
        `Unsupported derived property expression: ${String(e.type)}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Plan fulfilment — searchAround hops + static rids
// ---------------------------------------------------------------------------

async function fulfilPlans(
  compiled: CompiledObjectSet,
  deps: ExecutorDeps,
): Promise<CompiledPlan[]> {
  const out: CompiledPlan[] = [];
  for (const plan of compiled.plans) {
    if (plan.staticRids) {
      if (!deps.resolveStaticRids) {
        throw new ObjectSetExecutionError(
          "StaticObjectSetUnsupported",
          "Static object set resolution is not configured.",
        );
      }
      const resolved = await deps.resolveStaticRids(plan.staticRids);
      const byType = new Map<string, string[]>();
      for (const r of resolved) {
        const list = byType.get(r.objectType) ?? [];
        list.push(r.primaryKey);
        byType.set(r.objectType, list);
      }
      for (const [objectType, pks] of byType) {
        out.push({ ...plan, objectType, staticRids: undefined, where: { type: "in", field: "__pk", value: pks } });
      }
      continue;
    }
    if (plan.searchAround) {
      if (!deps.traverse) {
        throw new ObjectSetExecutionError(
          "SearchAroundUnsupported",
          "Link traversal is not configured.",
        );
      }
      const hop = plan.searchAround;
      const result = await deps.traverse({
        fromObjectType: hop.fromObjectType,
        link: hop.link,
        anchorWhere: plan.searchAroundSourceWhere ?? null,
        interfaceLink: hop.interfaceLink,
      });
      const traversals = Array.isArray(result) ? result : [result];
      for (const traversal of traversals) {
        if (traversal.targetPks.length === 0) continue;
        out.push({
          ...plan,
          objectType: traversal.targetObjectType,
          searchAround: undefined,
          searchAroundSourceWhere: undefined,
          where: {
            type: "in",
            field: "__pk",
            value: traversal.targetPks,
          },
        });
      }
      continue;
    }
    out.push(plan);
  }
  return out;
}

// ---------------------------------------------------------------------------
// loadObjects
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 100;

export async function loadObjectSet(
  compiled: CompiledObjectSet,
  req: LoadObjectSetRequestV2,
  ctx: ExecutionContext,
  deps: ExecutorDeps,
): Promise<{
  data: Array<Record<string, unknown>>;
  nextPageToken: string | null;
  totalCount: string;
  propertySecurities: unknown[];
}> {
  const pageSize = req.pageSize ?? DEFAULT_PAGE_SIZE;
  const orderBy = req.orderBy?.fields ?? [];
  const relevanceOrder = req.orderBy?.orderType === "relevance";
  const requestFingerprint = objectSetFingerprint({
    objectSet: compiled.fingerprint,
    orderBy: req.orderBy ?? null,
    select: req.select ?? [],
    selectV2: req.selectV2 ?? [],
    defaultLoadLevel: req.defaultLoadLevel ?? null,
    pageSize,
    excludeRid: req.excludeRid === true,
    loadPropertySecurities: req.loadPropertySecurities === true,
    snapshot: req.snapshot === true,
    includeComputeUsage: req.includeComputeUsage === true,
    referenceSigningOptions: req.referenceSigningOptions ?? null,
    tenant: ctx.tenant,
    userId: ctx.userId ?? null,
    securityFingerprint: ctx.securityFingerprint ?? null,
    transactionId: ctx.transactionId,
    scenarioRid: ctx.scenarioRid,
  });

  let cursors: Record<string, unknown[]> = {};
  let pitIds: Record<string, string> = {};
  let transactionVersion = ctx.transactionVersion ?? null;
  let scenarioVersion = ctx.scenarioVersion ?? null;
  if (req.pageToken) {
    const payload = decodePageTokenV2(req.pageToken, {
      ontologyRid: ctx.ontologyRid,
      branchRid: ctx.branchRid,
      fingerprint: compiled.fingerprint,
      requestFingerprint,
      tenant: ctx.tenant,
      transactionId: ctx.transactionId,
      scenarioRid: ctx.scenarioRid,
    });
    cursors = payload.cursors;
    pitIds = payload.pitIds ?? {};
    // A snapshot remains pinned to the context versions from page one even
    // when the live transaction/scenario receives concurrent edits.
    transactionVersion =
      payload.transactionVersion ?? ctx.transactionVersion ?? null;
    scenarioVersion =
      payload.scenarioVersion ?? ctx.scenarioVersion ?? null;
  }

  const plans = await fulfilPlans(compiled, deps);
  if (plans.length === 0) {
    return {
      data: [],
      nextPageToken: null,
      totalCount: "0",
      propertySecurities: [],
    };
  }
  if (deps.authorizeProperties && orderBy.length > 0) {
    const fields = orderBy
      .map((entry) => entry.field)
      .filter((field): field is string => typeof field === "string");
    await Promise.all(
      plans.map((plan) =>
        deps.authorizeProperties!(plan.objectType, fields, "order"),
      ),
    );
  }
  const concreteObjectTypes = [
    ...new Set(plans.map((plan) => plan.objectType)),
  ];
  if (ctx.snapshot) {
    if (!deps.createPointInTime || !deps.closePointInTime) {
      throw new ObjectSetExecutionError(
        "ConsistentSnapshotError",
        "Consistent snapshots are unavailable for this search backend.",
        {},
        409,
      );
    }
    if (req.pageToken) {
      const missing = concreteObjectTypes.filter((type) => !pitIds[type]);
      if (missing.length > 0) {
        throw new ObjectSetExecutionError(
          "ConsistentSnapshotError",
          "The page token does not contain a complete snapshot.",
          { objectTypes: missing },
          409,
        );
      }
    } else {
      if (!deps.assertSnapshotReady) {
        throw new ObjectSetExecutionError(
          "ConsistentSnapshotError",
          "The writeback consistency preflight is unavailable.",
          {},
          409,
        );
      }
      await deps.assertSnapshotReady(concreteObjectTypes);
      pitIds = await deps.createPointInTime(concreteObjectTypes);
    }
  }

  const perPlanLimit =
    plans.length === 1 ? pageSize + 1 : Math.max(pageSize + 1, 2 * (pageSize + 1));

  let planResults: Array<{
    plan: CompiledPlan;
    hits: Array<Record<string, unknown>>;
    total: number;
  }>;
  try {
    planResults = await Promise.all(
      plans.map(async (plan) => {
      const body: Record<string, unknown> = {
        size: perPlanLimit,
        query: plan.where
          ? await deps.translateWhere(plan.objectType, plan.where)
          : { match_all: {} },
        track_total_hits: true,
        sort: await buildSort(
          orderBy,
          relevanceOrder,
          plan.objectType,
          deps,
        ),
      };
      if (plan.knn) {
        const knn = await buildKnn(plan, deps);
        body.query = plan.where
          ? {
              bool: {
                must: [
                  knn,
                  await deps.translateWhere(plan.objectType, plan.where),
                ],
              },
            }
          : knn;
      }
      const cursor = cursors[plan.objectType];
      if (cursor) body.search_after = cursor;
      const r = await deps.search(
        plan.objectType,
        body,
        ctx.snapshot ? { pitId: pitIds[plan.objectType] } : undefined,
      );
      let hits: Array<Record<string, unknown>> = r.hits.map((h) => ({
        ...h._source,
        __primaryKey: h._source.__pk ?? h._id,
        __apiName: plan.objectType,
        __rid:
          h._source.__rid ??
          deterministicObjectRid(
            ctx.ontologyRid,
            plan.objectType,
            String(h._source.__pk ?? h._id),
          ),
        _sort: h._sort,
        _score: h._score,
      }));
      // Overlay merge (read-your-writes). Snapshot semantics are
      // enforced by the deps factory (strict mode errors upstream).
      if (!ctx.snapshot && deps.mergeOverlay) {
        hits = await deps.mergeOverlay(plan.objectType, hits, plan.where);
      }
      if (deps.composeReadContext) {
        hits = await deps.composeReadContext(
          plan.objectType,
          hits,
          plan.where,
          { transactionVersion, scenarioVersion },
        );
        // Context-created objects do not have an OpenSearch sort tuple. Give
        // every composed object the same deterministic tuple used by the base
        // query, then apply the page cursor to overlay objects as well.
        if (!relevanceOrder) {
          hits = hits
            .map((hit) => ({
              ...hit,
              _sort: sortValuesForObject(hit, orderBy),
            }))
            .filter(
              (hit) =>
                !cursor ||
                compareSortValues(
                  hit._sort as unknown[],
                  cursor,
                  orderBy,
                ) > 0,
            );
        }
      }
      // Overlay/context composition may introduce newly-created values that
      // did not originate as OpenSearch hits. Re-assert the public identity
      // envelope after all composition so selection metadata never receives
      // an undefined object type and clients always see stable system fields.
      hits = hits.map((hit) => {
        const primaryKey = String(
          hit.__primaryKey ?? hit.__pk ?? "",
        );
        return {
          ...hit,
          __primaryKey: primaryKey,
          __apiName: plan.objectType,
          __rid:
            hit.__rid ??
            deterministicObjectRid(
              ctx.ontologyRid,
              plan.objectType,
              primaryKey,
            ),
        };
      });
      // Property authorization MUST run on the final composed value and
      // BEFORE derived properties, otherwise a derived expression can reveal
      // a restricted input.
      if (deps.secureProperties) {
        hits = await deps.secureProperties(plan.objectType, hits);
      }
      if (
        req.referenceSigningOptions?.signMediaReferences === true &&
        deps.signMediaReferences
      ) {
        hits = await deps.signMediaReferences(plan.objectType, hits);
      }
      // Derived properties (withProperties).
      if (plan.derivedProperties) {
        hits = hits.map((h) => {
          const out = { ...h };
          for (const [name, expr] of Object.entries(plan.derivedProperties!)) {
            out[name] = evaluateDerivedProperty(expr, h);
          }
          return out;
        });
      }
        const total = deps.adjustReadContextTotal
          ? await deps.adjustReadContextTotal(
              plan.objectType,
              r.total,
              plan.where,
              { transactionVersion, scenarioVersion },
            )
          : r.total;
        return { plan, hits, total };
      }),
    );
  } catch (err) {
    if (ctx.snapshot && Object.keys(pitIds).length > 0) {
      await deps.closePointInTime!(pitIds).catch(() => undefined);
    }
    throw err;
  }

  // Cross-type deterministic merge: global sort by orderBy fields,
  // tie-broken by (__apiName, __primaryKey). Dedupe by identity.
  const all: Array<Record<string, unknown>> = planResults.flatMap(
    (pr) =>
      pr.hits.map((h) => ({ ...h, __planType: pr.plan.objectType })),
  );
  all.sort(makeGlobalComparator(orderBy, relevanceOrder));
  const seen = new Set<string>();
  const deduped: typeof all = [];
  for (const h of all) {
    const id = `${h.__apiName}${h.__primaryKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(h);
  }

  const hasMore = deduped.length > pageSize;
  const page = deduped.slice(0, pageSize);

  // Per-type cursors from the last emitted item of each type.
  let nextPageToken: string | null = null;
  if (hasMore) {
    const nextCursors: Record<string, unknown[]> = {};
    for (const h of page) {
      const t = h.__planType as string;
      const sort = h._sort as unknown[] | undefined;
      if (sort) nextCursors[t] = sort;
    }
    // Carry forward cursors for types absent from this page.
    for (const [t, c] of Object.entries(cursors)) {
      if (!(t in nextCursors)) nextCursors[t] = c;
    }
    nextPageToken = createPageTokenV2({
      ontologyRid: ctx.ontologyRid,
      branchRid: ctx.branchRid,
      fingerprint: compiled.fingerprint,
      requestFingerprint,
      tenant: ctx.tenant,
      transactionId: ctx.transactionId,
      transactionVersion,
      scenarioRid: ctx.scenarioRid,
      scenarioVersion,
      orderBy,
      cursors: nextCursors,
      ...(ctx.snapshot ? { pitIds } : {}),
    });
  } else if (ctx.snapshot && Object.keys(pitIds).length > 0) {
    await deps.closePointInTime!(pitIds).catch(() => undefined);
  }

  // Select + excludeRid shaping.
  const metadataByType = new Map<string, ObjectTypeSelectionMetadata>();
  if (deps.getSelectionMetadata) {
    await Promise.all(
      [...new Set(page.map((h) => String(h.__apiName)))].map(async (objectType) => {
        metadataByType.set(
          objectType,
          await deps.getSelectionMetadata!(objectType),
        );
      }),
    );
  }
  const shaped = page.map((h) =>
    shapeObject(
      h,
      req.select ?? [],
      req.selectV2 ?? [],
      metadataByType.get(String(h.__apiName)),
      req.excludeRid === true,
      req.defaultLoadLevel,
    ),
  );
  const { data, propertySecurities } = finalizePropertySecurities(
    shaped,
    req.loadPropertySecurities === true,
  );
  const totalCount = planResults
    .reduce((sum, result) => sum + result.total, 0)
    .toString();
  return {
    data,
    nextPageToken,
    totalCount,
    propertySecurities,
  };
}

function sortValuesForObject(
  object: Record<string, unknown>,
  orderBy: Array<{ field: string; direction: "asc" | "desc" }>,
): unknown[] {
  const fields = [...orderBy];
  if (!fields.some((field) => field.field === "__pk")) {
    fields.push({ field: "__pk", direction: "asc" });
  }
  return fields.map((field) =>
    field.field === "__pk"
      ? object.__pk ?? object.__primaryKey
      : object[field.field],
  );
}

function compareSortValues(
  left: unknown[],
  right: unknown[],
  orderBy: Array<{ field: string; direction: "asc" | "desc" }>,
): number {
  const fields = [...orderBy];
  if (!fields.some((field) => field.field === "__pk")) {
    fields.push({ field: "__pk", direction: "asc" });
  }
  for (let index = 0; index < fields.length; index++) {
    const a = left[index];
    const b = right[index];
    if (a === b || (a == null && b == null)) continue;
    if (a == null) return 1;
    if (b == null) return -1;
    const direction = fields[index]!.direction === "desc" ? -1 : 1;
    if ((a as string | number) < (b as string | number)) {
      return -1 * direction;
    }
    if ((a as string | number) > (b as string | number)) {
      return direction;
    }
  }
  return 0;
}

async function buildSort(
  orderBy: Array<{ field: string; direction: "asc" | "desc" }>,
  relevanceOrder: boolean,
  objectType: string,
  deps: ExecutorDeps,
): Promise<Array<Record<string, unknown>>> {
  if (relevanceOrder && orderBy.length === 0) {
    // Deliberately no deterministic tiebreak: the public contract states
    // relevance ordering is not guaranteed to remain consistent across
    // pages and recommends a single page when completeness is required.
    return [{ _score: { order: "desc" } }];
  }
  const sorts: Array<Record<string, unknown>> = [];
  for (const field of orderBy) {
    const indexField =
      field.field.startsWith("__")
        ? field.field
        : await deps.keywordOf(objectType, field.field);
    sorts.push({ [indexField]: { order: field.direction } });
  }
  if (!sorts.some((s) => "__pk" in s)) sorts.push({ __pk: { order: "asc" } });
  return sorts;
}

async function buildKnn(
  plan: CompiledPlan,
  deps: ExecutorDeps,
): Promise<Record<string, unknown>> {
  const knn = plan.knn!;
  if (!deps.resolveKnnVector && knn.query.type === "text") {
    throw new ObjectSetExecutionError(
      "NearestNeighborsTextNotConfigured",
      "Text nearest-neighbor queries require an embedding model " +
        "configured on the property. Use a vector query.",
      { field: knn.field },
    );
  }
  const vector = deps.resolveKnnVector
    ? await deps.resolveKnnVector(plan.objectType, knn.field, knn.query)
    : (knn.query as { type: "vector"; value: number[] }).value;
  const clause: Record<string, unknown> = {
    knn: {
      [knn.field]: {
        vector,
        k: knn.numNeighbors,
        ...(knn.similarityThreshold === undefined
          ? {}
          : { min_score: knn.similarityThreshold }),
      },
    },
  };
  return clause;
}

function makeGlobalComparator(
  orderBy: Array<{ field: string; direction: "asc" | "desc" }>,
  relevanceOrder: boolean,
) {
  return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    if (relevanceOrder) {
      const av = typeof a._score === "number" ? a._score : 0;
      const bv = typeof b._score === "number" ? b._score : 0;
      if (av !== bv) return bv - av;
    }
    for (const f of orderBy) {
      const av = a[f.field];
      const bv = b[f.field];
      const dir = f.direction === "desc" ? -1 : 1;
      if (av === bv || (av == null && bv == null)) continue;
      if (av == null) return 1; // nulls last
      if (bv == null) return -1;
      if ((av as number | string) < (bv as number | string)) return -1 * dir;
      if ((av as number | string) > (bv as number | string)) return 1 * dir;
    }
    // deterministic tie-break
    const at = `${a.__apiName}${a.__primaryKey}`;
    const bt = `${b.__apiName}${b.__primaryKey}`;
    return at < bt ? -1 : at > bt ? 1 : 0;
  };
}

function shapeObject(
  hit: Record<string, unknown>,
  select: string[],
  selectV2: PropertyIdentifier[],
  metadata: ObjectTypeSelectionMetadata | undefined,
  excludeRid: boolean,
  defaultLoadLevel?: { type: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // System identity — always present.
  out.__primaryKey = hit.__primaryKey ?? null;
  out.__apiName = hit.__apiName ?? hit.__objectType ?? null;
  if (!excludeRid && hit.__rid != null) out.__rid = hit.__rid;
  const internal = new Set([
    "__pk", "__objectType", "__apiName", "__primaryKey", "__rid",
    "_sort", "_score", "__planType", "__branch", "__lastModified", "__version",
    "__editedBy", "__datasourceVersion", "_security",
  ]);
  if (select.length > 0 || selectV2.length > 0) {
    for (const p of select) {
      if (p.startsWith("__") || hit[p] == null) continue;
      out[p] = applyLoadLevel(
        hit[p],
        defaultLoadLevel,
        metadata?.properties[p],
      );
    }
    for (const identifier of selectV2) {
      applyPropertyIdentifier(out, hit, identifier, metadata);
    }
  } else {
    for (const [k, v] of Object.entries(hit)) {
      if (internal.has(k) || k.startsWith("__")) continue;
      if (v == null) continue;
      if (isVectorProperty(metadata?.properties[k]?.baseType)) continue;
      out[k] = applyLoadLevel(
        v,
        defaultLoadLevel,
        metadata?.properties[k],
      );
    }
  }
  const security = hit.__propertySecurity as
    | Record<string, PropertySecurityDescriptor>
    | undefined;
  if (security) {
    const selectedSecurity = Object.fromEntries(
      Object.entries(security).filter(([property]) => property in out),
    );
    if (Object.keys(selectedSecurity).length > 0) {
      out.__propertySecurity = selectedSecurity;
    }
  }
  return out;
}

interface PropertySecurityDescriptor {
  conjunctive: string[];
}

/**
 * Internal property-security descriptors never leave the executor. They are
 * replaced by the exact public SecuredPropertyValue shape and a response-wide
 * PropertySecurities dictionary when requested; otherwise they are simply
 * discarded because unauthorized values were already removed by the security
 * dependency.
 */
function finalizePropertySecurities(
  objects: Array<Record<string, unknown>>,
  requested: boolean,
): {
  data: Array<Record<string, unknown>>;
  propertySecurities: unknown[];
} {
  const securities: unknown[] = [];
  const indexByKey = new Map<string, number>();
  const data = objects.map((object) => {
    const descriptors =
      (object.__propertySecurity as
        | Record<string, PropertySecurityDescriptor>
        | undefined) ?? {};
    const out = { ...object };
    delete out.__propertySecurity;
    if (!requested) return out;
    for (const [property, descriptor] of Object.entries(descriptors)) {
      if (!(property in out)) continue;
      const required = [...new Set(descriptor.conjunctive)].sort();
      const key = JSON.stringify(required);
      let index = indexByKey.get(key);
      if (index === undefined) {
        index = securities.length;
        indexByKey.set(key, index);
        securities.push({
          disjunction: [
            {
              type: "propertyMarkingSummary",
              ...(required.length === 0
                ? {}
                : { conjunctive: required }),
            },
          ],
        });
      }
      out[property] = {
        value: out[property],
        propertySecurityIndex: index,
      };
    }
    return out;
  });
  return { data, propertySecurities: securities };
}

function isVectorProperty(baseType: string | undefined): boolean {
  if (!baseType) return false;
  return (
    baseType === "vector" ||
    baseType === "embedding" ||
    baseType.endsWith("_vector")
  );
}

function applyPropertyIdentifier(
  out: Record<string, unknown>,
  hit: Record<string, unknown>,
  identifier: PropertyIdentifier,
  metadata: ObjectTypeSelectionMetadata | undefined,
): void {
  const value = identifier as Record<string, unknown>;
  switch (value.type) {
    case "property": {
      const apiName = String(value.apiName);
      if (hit[apiName] != null) {
        out[apiName] = applyLoadLevel(
          hit[apiName],
          undefined,
          metadata?.properties[apiName],
        );
      }
      return;
    }
    case "structField": {
      const property = String(value.propertyApiName);
      const field = String(value.structFieldApiName);
      const struct = hit[property];
      if (!struct || typeof struct !== "object" || Array.isArray(struct)) return;
      const fieldValue = (struct as Record<string, unknown>)[field];
      if (fieldValue == null) return;
      const current =
        out[property] && typeof out[property] === "object"
          ? (out[property] as Record<string, unknown>)
          : {};
      out[property] = { ...current, [field]: fieldValue };
      return;
    }
    case "propertyWithLoadLevel": {
      const nested = value.propertyIdentifier as PropertyIdentifier;
      const temporary: Record<string, unknown> = {};
      applyPropertyIdentifier(temporary, hit, nested, metadata);
      for (const [property, raw] of Object.entries(temporary)) {
        out[property] = applyLoadLevel(
          raw,
          value.loadLevel as { type: string },
          metadata?.properties[property],
        );
      }
      return;
    }
    case "titleProperty": {
      const property = metadata?.titlePropertyApiName;
      if (property && hit[property] != null) out[property] = hit[property];
      return;
    }
    case "primaryKeyProperty": {
      const property = metadata?.primaryKeyPropertyApiName;
      if (property && hit[property] != null) out[property] = hit[property];
      return;
    }
  }
}

function applyLoadLevel(
  value: unknown,
  level: { type: string } | undefined,
  metadata:
    | {
        reducerConfig?: { type?: string } | null;
        structMainValueField?: string | null;
      }
    | undefined,
): unknown {
  if (!level || level.type === "noLoadLevel") return value;
  let loaded = value;
  if (
    level.type === "applyReducers" ||
    level.type === "applyReducersAndExtractMainValue"
  ) {
    if (Array.isArray(loaded) && metadata?.reducerConfig?.type) {
      const reducer = metadata.reducerConfig.type;
      if (reducer === "first") loaded = loaded[0];
      else if (reducer === "last") loaded = loaded[loaded.length - 1];
      else if (reducer === "min") {
        loaded = loaded.length ? Math.min(...loaded.map(Number)) : null;
      } else if (reducer === "max") {
        loaded = loaded.length ? Math.max(...loaded.map(Number)) : null;
      } else if (reducer === "sum") {
        loaded = loaded.reduce<number>((sum, item) => sum + Number(item), 0);
      }
    }
  }
  if (
    level.type === "extractMainValue" ||
    level.type === "applyReducersAndExtractMainValue"
  ) {
    const field = metadata?.structMainValueField;
    if (
      field &&
      loaded &&
      typeof loaded === "object" &&
      !Array.isArray(loaded)
    ) {
      loaded = (loaded as Record<string, unknown>)[field];
    }
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

export async function aggregateObjectSet(
  compiled: CompiledObjectSet,
  req: AggregateObjectSetRequestV2,
  ctx: ExecutionContext,
  deps: ExecutorDeps,
): Promise<{
  excludedItems?: number;
  accuracy: "ACCURATE" | "APPROXIMATE";
  data: Array<{ group: Record<string, unknown>; metrics: Array<{ name: string; value: unknown }> }>;
}> {
  const plans = await fulfilPlans(compiled, deps);
  if (plans.length === 0) {
    return { accuracy: "ACCURATE", data: [] };
  }
  if (deps.authorizeProperties) {
    const fields = [
      ...req.aggregation.flatMap((aggregation) =>
        "field" in aggregation && typeof aggregation.field === "string"
          ? [aggregation.field]
          : [],
      ),
      ...req.groupBy.flatMap((group) =>
        "field" in group && typeof group.field === "string"
          ? [group.field]
          : [],
      ),
    ];
    await Promise.all(
      plans.map((plan) =>
        deps.authorizeProperties!(
          plan.objectType,
          [...new Set(fields)],
          "aggregation",
        ),
      ),
    );
  }
  // Transaction/scenario overlays are composed after the base index query.
  // Aggregating the index directly would therefore miss created objects and
  // include deleted/pre-edit values. Materialize the secured composed view
  // with search_after and aggregate that exact view.
  if (deps.composeReadContext) {
    return aggregateComposedReadContext(plans, req, ctx, deps);
  }
  // Percentiles do not merge across plans — typed error, never
  // silently wrong.
  if (
    plans.length > 1 &&
    req.aggregation.some((a) => a.type === "approximatePercentile")
  ) {
    throw new ObjectSetExecutionError(
      "AggregationAccuracyNotSupported",
      "approximatePercentile cannot be computed over a cross-object-type set.",
    );
  }
  if (
    plans.length > 1 &&
    req.aggregation.some(
      (aggregation) =>
        aggregation.type === "exactDistinct" ||
        aggregation.type === "approximateDistinct",
    ) &&
    !(
      req.accuracy === "REQUIRE_ACCURATE" &&
      supportsCompositeGrouping(req.groupBy)
    )
  ) {
    throw new ObjectSetExecutionError(
      "AggregationAccuracyNotSupported",
      "Distinct aggregations cannot be merged exactly across object-type execution plans.",
      { objectTypeCount: plans.length },
    );
  }

  const keywordOf = (field: string) =>
    field === "__pk" ? "__pk" : `${field}.keyword`;

  if (
    req.accuracy === "REQUIRE_ACCURATE" &&
    supportsCompositeGrouping(req.groupBy)
  ) {
    const namedAggregation = req.aggregation.map((aggregation, index) => ({
      ...aggregation,
      name:
        aggregation.name ??
        `${aggregation.type}_${("field" in aggregation ? aggregation.field : "objects")}_${index}`,
    }));
    const nonDistinct = namedAggregation.filter(
      (aggregation) =>
        aggregation.type !== "exactDistinct" &&
        aggregation.type !== "approximateDistinct",
    );
    const mainRequest = { ...req, aggregation: nonDistinct };
    const perPlan = await Promise.all(
      plans.map((plan) =>
        executeExactCompositeAggregation(
          plan,
          mainRequest,
          deps,
        ),
      ),
    );
    const merged = mergePlanAggregations(
      perPlan.map((result) => result.parsed),
      nonDistinct,
      perPlan[0]!.metricNames,
    );
    const distinct = await executeExactDistinctAggregations(
      plans,
      req,
      deps,
    );
    const metricTypeByName = new Map(
      namedAggregation.map((aggregation) => [
        aggregation.name,
        aggregation.type,
      ]),
    );
    const data = merged.items.map((item) => {
      const key = JSON.stringify(item.group);
      const normal = new Map(
        item.metrics.map((metric) => [metric.name, metric.value]),
      );
      return {
        group: item.group,
        metrics: namedAggregation.map((aggregation) => {
          const name = aggregation.name;
          const type = metricTypeByName.get(name);
          return {
            name,
            value:
              type === "exactDistinct" || type === "approximateDistinct"
                ? (distinct.get(name)?.get(key) ?? 0)
                : (normal.get(name) ?? null),
          };
        }),
      };
    });
    return {
      accuracy: "ACCURATE",
      data,
    };
  }

  const perPlan = await Promise.all(
    plans.map(async (plan) => {
      const { aggs, metricNames } = buildV2Aggs(
        req.aggregation,
        req.groupBy,
        (f) => keywordOf(f),
      );
      const body: Record<string, unknown> = {
        size: 0,
        track_total_hits: true,
        query: plan.where
          ? await deps.translateWhere(plan.objectType, plan.where)
          : { match_all: {} },
        aggs,
      };
      const r = await deps.search(plan.objectType, body);
      return {
        plan,
        parsed: parseV2AggResponse(
          (r.aggregations ?? {}) as Record<string, never>,
          req.groupBy,
          metricNames,
        ),
        metricNames,
      };
    }),
  );

  // Cross-plan merge: objects belong to exactly one type, so
  // group keys are disjoint per type and metrics merge by
  // additive/weighted rules.
  const merged = mergePlanAggregations(
    perPlan.map((p) => p.parsed),
    req.aggregation,
    perPlan[0]!.metricNames,
  );
  const accuracy = assertAccuracy(merged, req.accuracy);
  const out: {
    excludedItems?: number;
    accuracy: "ACCURATE" | "APPROXIMATE";
    data: typeof merged.items;
  } = { accuracy, data: merged.items };
  if (merged.excludedItems > 0) out.excludedItems = merged.excludedItems;
  return out;
}

const EXACT_AGG_PAGE_SIZE = positiveIntegerEnv(
  "TELLUS_EXACT_AGG_PAGE_SIZE",
  1_000,
);
const EXACT_AGG_MAX_PAGES = positiveIntegerEnv(
  "TELLUS_EXACT_AGG_MAX_PAGES",
  2_000,
);
const EXACT_AGG_MAX_BUCKETS = positiveIntegerEnv(
  "TELLUS_EXACT_AGG_MAX_BUCKETS",
  1_000_000,
);
const EXACT_AGG_BUDGET_MS = positiveIntegerEnv(
  "TELLUS_EXACT_AGG_BUDGET_MS",
  120_000,
);
const EXACT_AGG_RETRIES = positiveIntegerEnv(
  "TELLUS_EXACT_AGG_RETRIES",
  5,
);

async function executeExactDistinctAggregations(
  plans: CompiledPlan[],
  req: AggregateObjectSetRequestV2,
  deps: ExecutorDeps,
): Promise<Map<string, Map<string, number>>> {
  const metrics = req.aggregation
    .map((aggregation, index) => ({
      aggregation,
      name:
        aggregation.name ??
        `${aggregation.type}_${("field" in aggregation ? aggregation.field : "objects")}_${index}`,
    }))
    .filter(
      (
        entry,
      ): entry is {
        aggregation:
          | { type: "exactDistinct"; field: string; name?: string }
          | { type: "approximateDistinct"; field: string; name?: string };
        name: string;
      } =>
        entry.aggregation.type === "exactDistinct" ||
        entry.aggregation.type === "approximateDistinct",
    );
  const result = new Map<string, Map<string, number>>();
  for (const metric of metrics) {
    const counts = new Map<string, number>();
    const seen = new Set<string>();
    result.set(metric.name, counts);
    for (const plan of plans) {
      const startedAt = Date.now();
      const resolvedKeywords = new Map<string, string>();
      await Promise.all(
        req.groupBy.map(async (grouping) => {
          if (grouping.type === "exact") {
            resolvedKeywords.set(
              grouping.field,
              await deps.keywordOf(plan.objectType, grouping.field),
            );
          }
        }),
      );
      const keywordOf = (field: string) =>
        resolvedKeywords.get(field) ??
        (field === "__pk" ? "__pk" : `${field}.keyword`);
      const distinctField = await deps.keywordOf(
        plan.objectType,
        metric.aggregation.field,
      );
      let after: Record<string, unknown> | undefined;
      let page = 0;
      do {
        page += 1;
        if (
          page > EXACT_AGG_MAX_PAGES ||
          Date.now() - startedAt > EXACT_AGG_BUDGET_MS
        ) {
          throw new ObjectSetExecutionError(
            "AggregationAccuracyNotSupported",
            "Exact distinct aggregation exceeded its execution budget.",
            { metric: metric.name, pages: page - 1 },
          );
        }
        const built = buildCompositeV2Aggs(
          [],
          req.groupBy,
          keywordOf,
          after,
          EXACT_AGG_PAGE_SIZE,
        );
        const root = built.aggs.__composite as {
          composite: {
            sources: Array<Record<string, unknown>>;
          };
        };
        root.composite.sources.push({
          __distinct: { terms: { field: distinctField } },
        });
        const response = await searchAggregationPageWithRetry(
          deps,
          plan.objectType,
          {
            size: 0,
            track_total_hits: false,
            query: plan.where
              ? await deps.translateWhere(plan.objectType, plan.where)
              : { match_all: {} },
            aggs: built.aggs,
          },
          startedAt,
        );
        const composite = (response.aggregations?.__composite ?? {}) as {
          buckets?: Array<{
            key?: Record<string, unknown>;
          }>;
          after_key?: Record<string, unknown>;
        };
        for (const bucket of composite.buckets ?? []) {
          const key = bucket.key ?? {};
          const group = compositeGroupFromKey(
            key,
            req.groupBy,
            built.sourceNames,
            built.groupNames,
          );
          const groupKey = JSON.stringify(group);
          const pairKey = JSON.stringify([group, key.__distinct]);
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
          if (seen.size > EXACT_AGG_MAX_BUCKETS) {
            throw new ObjectSetExecutionError(
              "AggregationAccuracyNotSupported",
              "Exact distinct aggregation exceeded the configured bucket budget.",
              {
                metric: metric.name,
                buckets: seen.size,
                maximumBuckets: EXACT_AGG_MAX_BUCKETS,
              },
            );
          }
        }
        if (
          (composite.buckets?.length ?? 0) === 0 ||
          !composite.after_key
        ) {
          break;
        }
        if (
          after &&
          JSON.stringify(after) === JSON.stringify(composite.after_key)
        ) {
          throw new ObjectSetExecutionError(
            "AggregationAccuracyNotSupported",
            "OpenSearch returned a non-advancing exact-distinct cursor.",
            { metric: metric.name, page },
          );
        }
        after = composite.after_key;
      } while (true);
    }
  }
  return result;
}

function compositeGroupFromKey(
  key: Record<string, unknown>,
  groupBy: AggregateObjectSetRequestV2["groupBy"],
  sourceNames: string[],
  groupNames: string[],
): Record<string, unknown> {
  const group: Record<string, unknown> = {};
  for (let index = 0; index < groupBy.length; index++) {
    const grouping = groupBy[index]!;
    let value = key[sourceNames[index]!];
    if (
      grouping.type === "exact" &&
      value == null &&
      grouping.includeNullValues
    ) {
      value = grouping.defaultValue ?? null;
    } else if (
      grouping.type === "duration" &&
      (typeof value === "number" ||
        (typeof value === "string" && /^\d+$/.test(value)))
    ) {
      value = new Date(Number(value)).toISOString();
    }
    group[groupNames[index]!] = value;
  }
  return group;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

async function executeExactCompositeAggregation(
  plan: CompiledPlan,
  req: AggregateObjectSetRequestV2,
  deps: ExecutorDeps,
): Promise<{
  parsed: {
    items: Array<{
      group: Record<string, unknown>;
      metrics: Array<{ name: string; value: unknown }>;
      _docCount?: number;
      _averageState?: Record<string, { sum: number; count: number }>;
    }>;
    excludedItems: number;
    approximate: boolean;
  };
  metricNames: string[];
}> {
  const startedAt = Date.now();
  const items: Array<{
    group: Record<string, unknown>;
    metrics: Array<{ name: string; value: unknown }>;
    _docCount?: number;
    _averageState?: Record<string, { sum: number; count: number }>;
  }> = [];
  let after: Record<string, unknown> | undefined;
  let page = 0;
  let metricNames: string[] = [];
  const resolvedKeywords = new Map<string, string>();
  await Promise.all(
    req.groupBy.map(async (grouping) => {
      if (grouping.type === "exact") {
        resolvedKeywords.set(
          grouping.field,
          await deps.keywordOf(plan.objectType, grouping.field),
        );
      }
    }),
  );
  const keywordOf = (field: string) =>
    resolvedKeywords.get(field) ??
    (field === "__pk" ? "__pk" : `${field}.keyword`);
  do {
    page += 1;
    if (
      page > EXACT_AGG_MAX_PAGES ||
      Date.now() - startedAt > EXACT_AGG_BUDGET_MS
    ) {
      throw new ObjectSetExecutionError(
        "AggregationAccuracyNotSupported",
        "Exact aggregation exceeded its execution budget.",
        {
          pages: page - 1,
          buckets: items.length,
          budgetMs: EXACT_AGG_BUDGET_MS,
        },
      );
    }
    const built = buildCompositeV2Aggs(
      req.aggregation,
      req.groupBy,
      keywordOf,
      after,
      EXACT_AGG_PAGE_SIZE,
    );
    metricNames = built.metricNames;
    const body: Record<string, unknown> = {
      size: 0,
      track_total_hits: false,
      query: plan.where
        ? await deps.translateWhere(plan.objectType, plan.where)
        : { match_all: {} },
      aggs: built.aggs,
    };
    const response = await searchAggregationPageWithRetry(
      deps,
      plan.objectType,
      body,
      startedAt,
    );
    const parsed = parseCompositeV2Page(
      (response.aggregations ?? {}) as Record<string, never>,
      req.aggregation,
      req.groupBy,
      built.metricNames,
      built.sourceNames,
      built.groupNames,
    );
    items.push(...parsed.items);
    if (items.length > EXACT_AGG_MAX_BUCKETS) {
      throw new ObjectSetExecutionError(
        "AggregationAccuracyNotSupported",
        "Exact aggregation exceeded the configured bucket budget.",
        {
          buckets: items.length,
          maximumBuckets: EXACT_AGG_MAX_BUCKETS,
        },
      );
    }
    if (parsed.items.length === 0 || !parsed.afterKey) break;
    if (after && JSON.stringify(after) === JSON.stringify(parsed.afterKey)) {
      throw new ObjectSetExecutionError(
        "AggregationAccuracyNotSupported",
        "OpenSearch returned a non-advancing composite cursor.",
        { page },
      );
    }
    after = parsed.afterKey;
  } while (true);
  return {
    parsed: {
      items,
      excludedItems: 0,
      approximate: false,
    },
    metricNames,
  };
}

async function searchAggregationPageWithRetry(
  deps: ExecutorDeps,
  objectType: string,
  body: Record<string, unknown>,
  startedAt: number,
): Promise<OsSearchResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= EXACT_AGG_RETRIES; attempt++) {
    try {
      return await deps.search(objectType, body);
    } catch (error) {
      lastError = error;
      if (
        attempt === EXACT_AGG_RETRIES ||
        Date.now() - startedAt >= EXACT_AGG_BUDGET_MS
      ) {
        break;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(5_000, 500 * 2 ** (attempt - 1))),
      );
    }
  }
  throw new ObjectSetExecutionError(
    "AggregationBackendUnavailable",
    "OpenSearch did not return an exact aggregation page after retries.",
    {
      retryable: true,
      attempts: EXACT_AGG_RETRIES,
      cause:
        lastError instanceof Error
          ? lastError.name
          : "UnknownAggregationBackendError",
    },
    503,
  );
}

async function aggregateComposedReadContext(
  plans: CompiledPlan[],
  req: AggregateObjectSetRequestV2,
  ctx: ExecutionContext,
  deps: ExecutorDeps,
): Promise<{
  excludedItems?: number;
  accuracy: "ACCURATE" | "APPROXIMATE";
  data: Array<{
    group: Record<string, unknown>;
    metrics: Array<{ name: string; value: unknown }>;
  }>;
}> {
  const documents: Array<Record<string, unknown>> = [];
  for (const plan of plans) {
    const base: Array<Record<string, unknown>> = [];
    let searchAfter: unknown[] | undefined;
    do {
      const body: Record<string, unknown> = {
        size: plan.knn ? plan.knn.numNeighbors : 5_000,
        track_total_hits: true,
        sort: [{ __pk: { order: "asc" } }],
        query: plan.where
          ? await deps.translateWhere(plan.objectType, plan.where)
          : { match_all: {} },
        ...(searchAfter ? { search_after: searchAfter } : {}),
      };
      if (plan.knn) {
        const knn = await buildKnn(plan, deps);
        body.query = plan.where
          ? {
              bool: {
                must: [
                  knn,
                  await deps.translateWhere(plan.objectType, plan.where),
                ],
              },
            }
          : knn;
      }
      const response = await deps.search(plan.objectType, body);
      for (const hit of response.hits) {
        base.push({
          ...hit._source,
          __pk: hit._source.__pk ?? hit._id,
          __primaryKey: hit._source.__pk ?? hit._id,
          __apiName: plan.objectType,
          __rid:
            hit._source.__rid ??
            deterministicObjectRid(
              ctx.ontologyRid,
              plan.objectType,
              String(hit._source.__pk ?? hit._id),
            ),
        });
      }
      searchAfter =
        response.hits.length > 0
          ? response.hits[response.hits.length - 1]!._sort
          : undefined;
      if (
        plan.knn ||
        response.hits.length < Number(body.size) ||
        !searchAfter
      ) {
        break;
      }
    } while (true);
    let composed = await deps.composeReadContext!(
      plan.objectType,
      base,
      plan.where,
      {
        transactionVersion: ctx.transactionVersion ?? null,
        scenarioVersion: ctx.scenarioVersion ?? null,
      },
    );
    if (deps.secureProperties) {
      composed = await deps.secureProperties(plan.objectType, composed);
    }
    if (plan.derivedProperties) {
      composed = composed.map((document) => {
        const out = { ...document };
        for (const [name, expression] of Object.entries(
          plan.derivedProperties!,
        )) {
          out[name] = evaluateDerivedProperty(expression, document);
        }
        return out;
      });
    }
    documents.push(...composed);
  }
  const unique = [
    ...new Map(
      documents.map((document) => [
        `${document.__apiName}:${document.__primaryKey}`,
        document,
      ]),
    ).values(),
  ];
  return aggregateDocuments(unique, req);
}

function aggregateDocuments(
  documents: Array<Record<string, unknown>>,
  req: AggregateObjectSetRequestV2,
): {
  excludedItems?: number;
  accuracy: "ACCURATE" | "APPROXIMATE";
  data: Array<{
    group: Record<string, unknown>;
    metrics: Array<{ name: string; value: unknown }>;
  }>;
} {
  interface Bucket {
    group: Record<string, unknown>;
    documents: Array<Record<string, unknown>>;
  }
  let buckets: Bucket[] = [{ group: {}, documents }];
  let excludedItems = 0;
  for (const grouping of req.groupBy) {
    const next = new Map<string, Bucket>();
    for (const bucket of buckets) {
      for (const document of bucket.documents) {
        const field =
          grouping.type === "objectType" ? "__apiName" : grouping.field;
        const raw = document[field];
        let value: unknown;
        if (grouping.type === "objectType") value = raw;
        else if (grouping.type === "exact") {
          if (raw == null && !grouping.includeNullValues) continue;
          value = raw ?? grouping.defaultValue ?? null;
        } else if (grouping.type === "fixedWidth") {
          if (typeof raw !== "number") continue;
          value =
            Math.floor(raw / grouping.fixedWidth) * grouping.fixedWidth;
        } else if (grouping.type === "ranges") {
          const range = grouping.ranges.find(
            (candidate) =>
              (candidate.startValue == null ||
                (raw as string | number) >=
                  (candidate.startValue as string | number)) &&
              (candidate.endValue == null ||
                (raw as string | number) <
                  (candidate.endValue as string | number)),
          );
          if (!range) continue;
          value = {
            startValue: range.startValue,
            endValue: range.endValue,
          };
        } else {
          const timestamp = new Date(String(raw)).getTime();
          if (!Number.isFinite(timestamp)) continue;
          const unitMs: Record<string, number> = {
            SECONDS: 1_000,
            MINUTES: 60_000,
            HOURS: 3_600_000,
            DAYS: 86_400_000,
            WEEKS: 604_800_000,
            MONTHS: 2_592_000_000,
            QUARTERS: 7_776_000_000,
            YEARS: 31_536_000_000,
          };
          const width = unitMs[grouping.unit]! * grouping.value;
          value = new Date(Math.floor(timestamp / width) * width).toISOString();
        }
        const group = { ...bucket.group, [field]: value };
        const key = JSON.stringify(group);
        const target = next.get(key) ?? { group, documents: [] };
        target.documents.push(document);
        next.set(key, target);
      }
    }
    const maximum =
      grouping.type === "exact"
        ? (grouping.maxGroupCount ?? MAX_GROUP_COUNT)
        : MAX_GROUP_COUNT;
    const ordered = [...next.values()].sort((a, b) =>
      JSON.stringify(a.group).localeCompare(JSON.stringify(b.group)),
    );
    if (ordered.length > maximum) {
      excludedItems += ordered
        .slice(maximum)
        .reduce((sum, bucket) => sum + bucket.documents.length, 0);
    }
    buckets = ordered.slice(0, maximum);
  }
  const approximate = excludedItems > 0;
  if (approximate && req.accuracy === "REQUIRE_ACCURATE") {
    throw new ObjectSetExecutionError(
      "AggregationAccuracyNotSupported",
      "Accurate aggregation cannot be guaranteed at the requested group limit.",
      { excludedItems },
      400,
    );
  }
  const data = buckets.map((bucket) => ({
    group: bucket.group,
    metrics: req.aggregation.map((aggregation, index) => {
      const field =
        "field" in aggregation ? aggregation.field : undefined;
      const values = field
        ? bucket.documents
            .map((document) => document[field])
            .filter((value) => value != null)
        : [];
      const numbers = values
        .filter((value): value is number => typeof value === "number")
        .sort((a, b) => a - b);
      let value: unknown;
      switch (aggregation.type) {
        case "count":
          value = bucket.documents.length;
          break;
        case "sum":
          value = numbers.reduce((sum, item) => sum + item, 0);
          break;
        case "avg":
          value =
            numbers.length > 0
              ? numbers.reduce((sum, item) => sum + item, 0) / numbers.length
              : null;
          break;
        case "min":
          value = numbers.length > 0 ? numbers[0] : null;
          break;
        case "max":
          value =
            numbers.length > 0 ? numbers[numbers.length - 1] : null;
          break;
        case "exactDistinct":
        case "approximateDistinct":
          value = new Set(values.map((item) => JSON.stringify(item))).size;
          break;
        case "approximatePercentile": {
          if (numbers.length === 0) value = null;
          else {
            const rank =
              (aggregation.approximatePercentile / 100) *
              (numbers.length - 1);
            const lower = Math.floor(rank);
            const upper = Math.ceil(rank);
            value =
              numbers[lower]! +
              (numbers[upper]! - numbers[lower]!) * (rank - lower);
          }
          break;
        }
      }
      return {
        name:
          aggregation.name ??
          `${aggregation.type}_${field ?? "objects"}_${index}`,
        value,
      };
    }),
  }));
  return {
    ...(excludedItems > 0 ? { excludedItems } : {}),
    accuracy: approximate ? "APPROXIMATE" : "ACCURATE",
    data,
  };
}

function mergePlanAggregations(
  parsed: Array<{
    items: Array<{
      group: Record<string, unknown>;
      metrics: Array<{ name: string; value: unknown }>;
      _docCount?: number;
      _averageState?: Record<string, { sum: number; count: number }>;
    }>;
    excludedItems: number;
    approximate: boolean;
  }>,
  aggregation: AggregateObjectSetRequestV2["aggregation"],
  metricNames: string[],
): {
  items: Array<{ group: Record<string, unknown>; metrics: Array<{ name: string; value: unknown }> }>;
  excludedItems: number;
  approximate: boolean;
} {
  if (parsed.length === 1) {
    const single = parsed[0]!;
    // Strip internal _docCount from the single-plan fast path.
    return {
      items: single.items.map(({ group, metrics }) => ({ group, metrics })),
      excludedItems: single.excludedItems,
      approximate: single.approximate,
    };
  }
  const typeByName = new Map(
    aggregation.map((a, i) => [
      a.name ?? `${a.type}_${(a as { field?: string }).field ?? "objects"}_${i}`,
      a.type,
    ]),
  );
  interface Slot {
    group: Record<string, unknown>;
    per: Map<
      string,
      {
        weighted: number;
        weight: number;
        nums: number[];
        exactSum: number;
        exactCount: number;
      }
    >;
  }
  const byKey = new Map<string, Slot>();
  let excluded = 0;
  let approximate = false;
  for (const p of parsed) {
    excluded += p.excludedItems;
    approximate ||= p.approximate;
    for (const item of p.items) {
      const key = JSON.stringify(item.group);
      let slot = byKey.get(key);
      if (!slot) {
        slot = { group: item.group, per: new Map() };
        byKey.set(key, slot);
      }
      for (const m of item.metrics) {
        const cur = slot.per.get(m.name) ?? {
          weighted: 0,
          weight: 0,
          nums: [],
          exactSum: 0,
          exactCount: 0,
        };
        if (typeof m.value === "number") {
          cur.nums.push(m.value);
          cur.weighted += m.value * (item._docCount ?? 0);
          cur.weight += item._docCount ?? 0;
        }
        const average = item._averageState?.[m.name];
        if (average) {
          cur.exactSum += average.sum;
          cur.exactCount += average.count;
        }
        slot.per.set(m.name, cur);
      }
    }
  }
  // Merge rule per verified metric semantics (objects are
  // disjoint across plans):
  //   count/sum/*Distinct → additive
  //   avg                 → weighted by bucket doc counts
  //   min/max             → extremum of plan extrema
  const items = [...byKey.values()]
    .map((slot) => ({
      group: slot.group,
      metrics: metricNames.map((name) => {
        const cur = slot.per.get(name);
        if (!cur || cur.nums.length === 0) return { name, value: null };
        switch (typeByName.get(name)) {
          case "avg":
            return {
              name,
              value:
                cur.exactCount > 0
                  ? cur.exactSum / cur.exactCount
                  : cur.weight > 0
                    ? cur.weighted / cur.weight
                    : null,
            };
          case "min":
            return { name, value: Math.min(...cur.nums) };
          case "max":
            return { name, value: Math.max(...cur.nums) };
          default: // count, sum, distincts
            return { name, value: cur.nums.reduce((a, b) => a + b, 0) };
        }
      }),
    }))
    .sort((left, right) =>
      JSON.stringify(left.group).localeCompare(JSON.stringify(right.group)),
    );
  return { items, excludedItems: excluded, approximate };
}
