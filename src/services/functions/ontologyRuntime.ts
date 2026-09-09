// ---------------------------------------------------------------------------
// ontologyRuntime.ts — the Ontology SDK that TypeScript Functions v2 author
// against, plus the snapshot loader and edit applier that back it.
//
// Foundry parity (docs/foundry-parity/CODE_REPOSITORIES_AND_FUNCTIONS_V2.md
// pieces B2/B7/B8): a TS function reads the Ontology through a typed client
// (`Objects.search(...)`, object sets, aggregations) and expresses mutations
// through an edit batch (`Edits.create/update/delete`). Two contracts we mirror
// from Foundry:
//
//   1. SNAPSHOT ISOLATION — the function sees a single, consistent in-memory
//      view of the Ontology for the whole execution (like a DB snapshot), so
//      repeated reads never observe mid-flight writes. We materialise that
//      snapshot up-front from `object_instances` and serve every read from it.
//
//   2. EDITS DO NOT PERSIST EXCEPT VIA AN ACTION — running a function (Live
//      Preview) collects edits but does not mutate the Ontology; the caller
//      must opt in (our `applyEdits`, simulating a function-backed Action) to
//      write them back. In-function reads always see the PRE-edit state.
//
// The SDK is plain synchronous JS so it runs inside the `vm` sandbox without
// async (the sandbox cannot time promises). All heavy lifting (the DB load)
// happens before the sandbox runs.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Pool, PoolClient } from "pg";
import { getOverlayStore } from "../overlay/getOverlayStore";
import { writeOverlay } from "../overlay/writebackOverlay";
import type { OverlayRecord } from "../overlay/overlayStore";
import { sendSignal } from "../funnel/durableWorkflow";

/** A materialised object: its declared properties plus `$`-prefixed metadata. */
export interface OntologyObject {
  readonly $apiName: string;
  readonly $primaryKey: string;
  readonly $title: string;
  readonly [property: string]: unknown;
}

/** One pending mutation collected from a function execution. */
export type OntologyEdit =
  | { readonly op: "create"; readonly objectType: string; readonly primaryKey: string; readonly properties: Record<string, unknown>; readonly interfaceType?: string }
  | { readonly op: "update"; readonly objectType: string; readonly primaryKey: string; readonly patch: Record<string, unknown> }
  | { readonly op: "delete"; readonly objectType: string; readonly primaryKey: string }
  | { readonly op: "link"; readonly linkType: string; readonly sourcePrimaryKey: string; readonly targetPrimaryKey: string }
  | { readonly op: "unlink"; readonly linkType: string; readonly sourcePrimaryKey: string; readonly targetPrimaryKey: string };

// ---------------------------------------------------------------------------
// Link graph — parity with Foundry's generated Link Type accessors
// (docs/foundry/functions/api-objects-links §"Link types").
//
// Foundry converts every imported link type into fields on the generated
// object interfaces:
//   • `SingleLink` on the 1 side     — `object.parentLink.get()` → T | undefined
//   • `MultiLink`  on the many side  — `object.childLinks.all()` → T[]
//   • `ObjectSet.searchAroundTo<Link>()` — set-level pivot without loading
//     linked objects into memory (docs §"search around").
//
// The sandbox cannot ship generated TypeScript — it is a runtime, dynamic
// surface — so the equivalent surface is built in `buildOntologySdk` from this
// data model, attached lazily (non-enumerable getters) so plain-JSON object
// handling everywhere else is untouched.
// ---------------------------------------------------------------------------

export type LinkCardinality =
  | "ONE_TO_ONE"
  | "ONE_TO_MANY"
  | "MANY_TO_ONE"
  | "MANY_TO_MANY";

/**
 * One materialised link type: its metadata plus the resolved edge index.
 *
 * `forward` maps SOURCE primary keys → TARGET primary keys; `reverse` is the
 * mirror. Both directions are indexed so traverse-from-either-side stays
 * O(1)-per-edge at accessor time (Foundry link fields are bidirectional).
 */
export interface LinkSnapshotDef {
  readonly apiName: string;
  readonly reverseApiName: string | null;
  readonly cardinality: LinkCardinality;
  readonly sourceType: string;
  readonly targetType: string;
  /** sourcePk → targetPks (deduped; only edges whose SOURCE object loaded). */
  readonly forward: ReadonlyMap<string, readonly string[]>;
  /** targetPk → sourcePks (deduped). */
  readonly reverse: ReadonlyMap<string, readonly string[]>;
}

export interface OntologySnapshot {
  /** objectTypeApiName → (primaryKey → object). */
  readonly byType: Map<string, Map<string, OntologyObject>>;
  readonly ontologyId: string;
  readonly objectCount: number;
  readonly objectTypes: readonly string[];
  /**
   * Link types materialised for traversal, keyed by link apiName. Optional
   * for backward compatibility with callers that construct snapshots inline
   * (a snapshot without `links` simply exposes no link accessors — the
   * pre-feature behaviour, fail-silent).
   */
  readonly links?: ReadonlyMap<string, LinkSnapshotDef>;
  /**
   * The object types the code repository DECLARES as imports
   * (`code_repository_resource_imports`, `kind='object_type'`) — sourced from
   * `loadOntologySnapshot`'s `objectTypes` filter arg. This is the set a
   * generated `@ontology/sdk` would expose: a function may
   * `import { SomeType } from "@ontology/sdk"` for a type that has ZERO rows
   * in this snapshot. `objectTypeDescriptors` is keyed off this list (falling
   * back to `objectTypes` only when a caller didn't pass a filter), so
   * `SomeType.apiName` always resolves regardless of instance count.
   */
  readonly importedTypes?: readonly string[];
  /** Mirror of `importedTypes` for `kind='link_type'` imports. */
  readonly importedLinkTypes?: readonly string[];
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** resource_imports stores ontology_id as TEXT (may be a bare UUID or an RID). */
export function normalizeOntologyId(raw: string): string | null {
  const m = UUID_RE.exec(raw);
  return m ? m[0] : null;
}

export interface LoadSnapshotArgs {
  readonly ontologyId: string;
  /** Restrict to these object types (the repo's imported types). Empty = all. */
  readonly objectTypes?: readonly string[];
  /**
   * The repo's DECLARED link-type imports (`kind='link_type'`). When defined
   * (even as `[]`), ONLY these link types are materialised — Foundry parity:
   * a link you did not import is not traversable. When undefined, every link
   * type whose endpoint types are both loaded is derived (used by execution
   * paths that do not track resource imports, e.g. function-backed Actions
   * with an unimport-filtered snapshot).
   */
  readonly linkTypes?: readonly string[];
  /** Hard cap on rows materialised, to bound memory. */
  readonly limit?: number;
  /**
   * Optional abort signal (typically the request's `timeoutSignal`). When
   * aborted, the in-flight SELECT is cancelled server-side instead of running
   * to completion after the caller has already given up (504). `pg` honours
   * `signal` on the query config object.
   */
  readonly signal?: AbortSignal;
}

/**
 * Property-name translation for instance-store rows.
 *
 * `object_instances.properties` is populated by datasource adoption/merge
 * with RAW backing-datasource column names (e.g. `claim_id`, `signal_type`),
 * while the OpenSearch index (written by the reindex path's rowTransformer)
 * uses object-type property API names (`claimId`, `signalType`). Function
 * executions therefore saw a different object shape than REST search — the
 * same demo's `calculateClaimRiskScore` matched in OS-shaped data but found
 * zero rows against the instance store.
 *
 * `backing_datasource.column_mapping` ({ propertyApiName → sourceColumn })
 * is the authoritative contract between the two. We translate each loaded
 * row into API-name space ADDITIVELY: a camelCase key already present (e.g.
 * written by the Edits writeback) always wins over its raw-column sibling.
 */
async function loadColumnMappings(
  pool: Pool,
  ontologyId: string,
): Promise<Map<string, Record<string, string>>> {
  const result = await pool.query<{
    api_name: string;
    column_mapping: Record<string, string> | string | null;
  }>({
    text: `SELECT t.api_name, ds.column_mapping
            FROM backing_datasource ds
            JOIN object_type t ON t.object_type_id = ds.object_type_id
           WHERE t.ontology_id = $1::uuid`,
    values: [ontologyId],
  } as unknown as Parameters<typeof pool.query>[0]);
  const byType = new Map<string, Record<string, string>>();
  for (const row of result.rows) {
    const mapping =
      typeof row.column_mapping === "string"
        ? (JSON.parse(row.column_mapping) as Record<string, string>)
        : row.column_mapping;
    if (mapping && typeof mapping === "object") byType.set(row.api_name, mapping);
  }
  return byType;
}

function translatePropertiesToApiNames(
  props: Record<string, unknown>,
  mapping: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!mapping) return props;
  let translated: Record<string, unknown> | null = null;
  for (const [apiName, sourceColumn] of Object.entries(mapping)) {
    if (apiName === sourceColumn) continue;
    // Existing API-name value (e.g. from an Action edit) always wins.
    if (props[apiName] !== undefined) continue;
    if (props[sourceColumn] === undefined) continue;
    if (!translated) translated = { ...props };
    translated[apiName] = props[sourceColumn];
  }
  return translated ?? props;
}

/**
 * Materialise a consistent in-memory view of the Ontology for one function
 * execution. Reads the latest row per (object_type, primary_key).
 */
export async function loadOntologySnapshot(
  pool: Pool,
  args: LoadSnapshotArgs,
): Promise<OntologySnapshot> {
  const limit = Math.min(Math.max(args.limit ?? 50_000, 1), 200_000);
  const params: unknown[] = [args.ontologyId];
  let typeFilter = "";
  if (args.objectTypes && args.objectTypes.length > 0) {
    params.push(args.objectTypes);
    typeFilter = `AND object_type_api_name = ANY($${params.length})`;
  }
  params.push(limit);
  // `pg` honours a `signal` on the query config at runtime (it cancels the
  // in-flight SELECT server-side when the request aborts), but its TypeScript
  // `QueryConfig` type doesn't include it — cast to add it.
  const result = await pool.query<{
    object_type_api_name: string;
    primary_key: string;
    properties: Record<string, unknown>;
  }>({
    text: `SELECT object_type_api_name, primary_key, properties
       FROM object_instances
      WHERE ontology_id = $1::uuid ${typeFilter}
      ORDER BY object_type_api_name, last_modified_at DESC
      LIMIT $${params.length}`,
    values: params,
    signal: args.signal,
  } as unknown as Parameters<typeof pool.query>[0]);
  const { rows } = result;

  const columnMappings = await loadColumnMappings(pool, args.ontologyId);

  const byType = new Map<string, Map<string, OntologyObject>>();
  let count = 0;
  for (const r of rows) {
    let bucket = byType.get(r.object_type_api_name);
    if (!bucket) {
      bucket = new Map();
      byType.set(r.object_type_api_name, bucket);
    }
    // ORDER BY last_modified_at DESC → first row per pk wins (latest).
    if (bucket.has(r.primary_key)) continue;
    const props = translatePropertiesToApiNames(
      r.properties ?? {},
      columnMappings.get(r.object_type_api_name),
    );
    const title =
      (typeof props.title === "string" && props.title) ||
      (typeof props.name === "string" && props.name) ||
      (typeof props.display_name === "string" && props.display_name) ||
      r.primary_key;
    bucket.set(r.primary_key, {
      ...props,
      $apiName: r.object_type_api_name,
      $primaryKey: r.primary_key,
      $title: String(title),
    });
    count += 1;
  }
  // Link graph: derive edges for every imported link type whose endpoint
  // types both loaded. Runs AFTER the object pass so FK edges can be
  // resolved in memory (no extra queries for FK-backed links; one bounded
  // JOIN query for the type/property metadata and, when present, the M2M
  // projections in `link_instances` / CSV join tables).
  const links = await loadLinkGraph(pool, args.ontologyId, byType, args.linkTypes, args.signal);
  // `importedTypes` mirrors the caller's `objectTypes` filter (the repo's
  // declared imports) so `buildOntologySdk` can build `objectTypeDescriptors`
  // from DECLARED imports — not just types that happen to have rows. Undefined
  // when the caller passed no filter (buildOntologySdk then falls back to the
  // loaded `objectTypes`, preserving the pre-fix behaviour for unfiltered loads).
  return {
    byType,
    ontologyId: args.ontologyId,
    objectCount: count,
    objectTypes: [...byType.keys()],
    importedTypes: args.objectTypes,
    importedLinkTypes: args.linkTypes,
    links,
  };
}

// ---------------------------------------------------------------------------
// loadLinkGraph — materialise the traversable edge index a function sees.
//
// Edge derivation mirrors linkResolverService.resolveLinks EXACTLY so the
// sandbox graph is identical to the REST search-around graph:
//
//   ONE_TO_MANY  target object's `target_property` FK column == source pk
//   MANY_TO_ONE  source object's `source_property` FK column == target pk
//   ONE_TO_ONE   source FK when defined, otherwise the target FK
//   MANY_TO_MANY CSV join table when configured, else the target FK; plus a
//                union with the `link_instances` projection (edit-applicator
//                edges created via Edits / createEditBatch().link).
//
// Cost: FK edges are derived in memory from the already-loaded objects
// (one pass per link type — no per-edge queries). M2M projections are a
// single bounded SELECT (guard: table presence via to_regclass) and one
// best-effort fs read per CSV join table. Total work is
// O(Σ rows of touched types + M2M edges) — dwarfed by the object SELECT.
// ---------------------------------------------------------------------------

interface LinkTypeRow {
  readonly api_name: string;
  readonly reverse_api_name: string | null;
  readonly reverse_visible: boolean | null;
  readonly cardinality: LinkCardinality;
  readonly source_type: string;
  readonly target_type: string;
  readonly source_prop: string | null;
  readonly target_prop: string | null;
  readonly join_table_file_path: string | null;
}

/** Cap on M2M edges materialised from projections/CSV — bounds memory. */
const MAX_M2M_EDGES_PER_LINK = 100_000;

function isFkValue(v: unknown): v is string | number {
  return (
    v !== null &&
    v !== undefined &&
    v !== "" &&
    (typeof v === "string" || (typeof v === "number" && Number.isFinite(v)))
  );
}

function pushEdge(
  forward: Map<string, string[]>,
  reverse: Map<string, string[]>,
  sourcePk: string,
  targetPk: string,
): void {
  const f = forward.get(sourcePk);
  if (f) { if (!f.includes(targetPk)) f.push(targetPk); } else forward.set(sourcePk, [targetPk]);
  const r = reverse.get(targetPk);
  if (r) { if (!r.includes(sourcePk)) r.push(sourcePk); } else reverse.set(targetPk, [sourcePk]);
}

/**
 * Read a legacy CSV join table (same convention as
 * linkResolverService.parseJoinTableCSV: header row + `<source>,<target>`
 * lines). Best-effort: a missing/unreadable file yields no edges rather than
 * failing the whole snapshot load (the REST resolver behaves the same).
 */
function readJoinTableCsv(
  filePath: string,
): Array<{ source: string; target: string }> {
  try {
    if (!existsSync(filePath)) return [];
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length < 2) return [];
    const rows: Array<{ source: string; target: string }> = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",").map((c) => c.trim());
      if (cols.length >= 2 && cols[0] && cols[1]) {
        rows.push({ source: cols[0], target: cols[1] });
        if (rows.length >= MAX_M2M_EDGES_PER_LINK) break;
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function loadLinkGraph(
  pool: Pool,
  ontologyId: string,
  byType: ReadonlyMap<string, Map<string, OntologyObject>>,
  importedLinkTypes: readonly string[] | undefined,
  signal?: AbortSignal,
): Promise<Map<string, LinkSnapshotDef>> {
  const out = new Map<string, LinkSnapshotDef>();
  // One query resolves link types + endpoint type apiNames + FK property
  // apiNames (link_type stores object_type/property UUIDs — mirroring how
  // linkResolverService resolves them row-by-row).
  let rows: LinkTypeRow[];
  try {
    const res = await pool.query<LinkTypeRow>({
      text: `SELECT lt.api_name,
                    lt.reverse_api_name,
                    lt.reverse_visible,
                    lt.cardinality,
                    so.api_name AS source_type,
                    to_ot.api_name AS target_type,
                    sp.api_name AS source_prop,
                    tp.api_name AS target_prop,
                    lt.join_table_file_path
               FROM link_type lt
               JOIN object_type so ON so.object_type_id = lt.source_object_type
               JOIN object_type to_ot ON to_ot.object_type_id = lt.target_object_type
               LEFT JOIN property sp ON sp.property_id = lt.source_property_id
               LEFT JOIN property tp ON tp.property_id = lt.target_property_id
              WHERE lt.ontology_id = $1::uuid`,
      values: [ontologyId],
      signal,
    } as unknown as Parameters<typeof pool.query>[0]);
    rows = res.rows;
  } catch {
    // The link_type table was introduced after the earliest deployments; a
    // schema without it simply exposes no links (fail-silent, pre-feature
    // behaviour — object reads are unaffected).
    return out;
  }

  // M2M projections: edges persisted by the edit applicator (optionally
  // absent on older schemas — guarded like link_edit is in applyEdits).
  let instanceEdges: Array<{
    link_type_api_name: string;
    source_primary_key: string;
    target_primary_key: string;
  }> = [];
  try {
    const present = await pool.query<{ exists: boolean }>(
      `SELECT to_regclass('link_instances') IS NOT NULL AS exists`,
    );
    if (present.rows[0]?.exists === true) {
      const res = await pool.query<{
        link_type_api_name: string;
        source_primary_key: string;
        target_primary_key: string;
      }>(
        `SELECT link_type_api_name, source_primary_key, target_primary_key
           FROM link_instances
          WHERE ontology_id = $1::uuid`,
        [ontologyId],
      );
      instanceEdges = res.rows;
    }
  } catch {
    instanceEdges = [];
  }

  const importFilter = importedLinkTypes ? new Set(importedLinkTypes) : null;

  for (const def of rows) {
    // Only materialise links whose endpoint types are BOTH in the snapshot —
    // a link whose far side wasn't imported cannot yield traversable objects.
    const sourceBucket = byType.get(def.source_type);
    const targetBucket = byType.get(def.target_type);
    if (!sourceBucket || !targetBucket) continue;
    // Resource-import scoping: only DECLARED link types are traversable.
    if (
      importFilter !== null &&
      !importFilter.has(def.api_name) &&
      !(def.reverse_api_name !== null && importFilter.has(def.reverse_api_name))
    ) {
      continue;
    }

    const forward = new Map<string, string[]>();
    const reverse = new Map<string, string[]>();

    switch (def.cardinality) {
      case "ONE_TO_MANY": {
        if (def.target_prop) {
          for (const t of targetBucket.values()) {
            const fk = t[def.target_prop];
            if (isFkValue(fk)) pushEdge(forward, reverse, String(fk), t.$primaryKey);
          }
        }
        break;
      }
      case "MANY_TO_ONE": {
        if (def.source_prop) {
          for (const s of sourceBucket.values()) {
            const fk = s[def.source_prop];
            if (isFkValue(fk)) pushEdge(forward, reverse, s.$primaryKey, String(fk));
          }
        }
        break;
      }
      case "ONE_TO_ONE": {
        if (def.source_prop) {
          for (const s of sourceBucket.values()) {
            const fk = s[def.source_prop];
            if (isFkValue(fk)) pushEdge(forward, reverse, s.$primaryKey, String(fk));
          }
        } else if (def.target_prop) {
          for (const t of targetBucket.values()) {
            const fk = t[def.target_prop];
            if (isFkValue(fk)) pushEdge(forward, reverse, String(fk), t.$primaryKey);
          }
        }
        break;
      }
      case "MANY_TO_MANY": {
        if (def.join_table_file_path) {
          for (const e of readJoinTableCsv(def.join_table_file_path)) {
            pushEdge(forward, reverse, e.source, e.target);
          }
        } else if (def.target_prop) {
          for (const t of targetBucket.values()) {
            const fk = t[def.target_prop];
            if (isFkValue(fk)) pushEdge(forward, reverse, String(fk), t.$primaryKey);
          }
        }
        break;
      }
      default:
        continue;
    }

    // Union in the persisted M2M projection (edit-applicator edges).
    for (const e of instanceEdges) {
      if (e.link_type_api_name === def.api_name) {
        pushEdge(forward, reverse, e.source_primary_key, e.target_primary_key);
      }
    }

    out.set(def.api_name, {
      apiName: def.api_name,
      reverseApiName: def.reverse_visible === false ? null : def.reverse_api_name,
      cardinality: def.cardinality,
      sourceType: def.source_type,
      targetType: def.target_type,
      forward,
      reverse,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Link accessors — Foundry's SingleLink / MultiLink surface, built by
// buildOntologySdk and attached to snapshot objects as NON-ENUMERABLE
// getters (so spreads / JSON.stringify / existing object handling are
// untouched and the accessors never leak over the wire).
// ---------------------------------------------------------------------------

/** The `1` side of a link: `employee.manager.get()` → Employee | undefined. */
export interface SingleLink<T = OntologyObject> {
  get(): T | undefined;
  getAsync(): Promise<T | undefined>;
}

/** The `many` side of a link: `employee.reports.all()` → Employee[]. */
export interface MultiLink<T = OntologyObject> {
  all(): T[];
  allAsync(): Promise<T[]>;
  count(): number;
  /**
   * Filtered access — Foundry surfaces the search API on large collections
   * so child sets can be narrowed without loading everything into memory.
   * Accepts a predicate or an equality `where` map; returns a chainable
   * ObjectSet (so `.filter()/.orderBy()/.sum()` and further
   * search-arounds compose).
   */
  search(where?: Record<string, unknown> | ((o: T) => unknown)): ObjectSet;
}

function matchesWhere(obj: OntologyObject, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    const key = k.startsWith("$") ? k : k;
    if (obj[key] !== v) return false;
  }
  return true;
}

interface LinkAccessorSpec {
  readonly name: string;
  readonly multi: boolean;
  readonly edges: ReadonlyMap<string, readonly string[]>;
  readonly targetType: string;
}

/** True when the given SIDE of the link resolves to many objects. */
function isManySide(cardinality: LinkCardinality, side: "source" | "target"): boolean {
  return side === "source"
    ? cardinality === "ONE_TO_MANY" || cardinality === "MANY_TO_MANY"
    : cardinality === "MANY_TO_ONE" || cardinality === "MANY_TO_MANY";
}

/**
 * Attach the generated link properties to every object of a type a link
 * touches. Called ONCE per `buildOntologySdk` (i.e. per worker execution —
 * accessors are functions and cannot cross `postMessage`). Idempotent:
 * already-decorated objects are skipped, so the in-process (non-worker) sync
 * fallback can decorate a cache-shared snapshot repeatedly.
 */
function attachLinkAccessors(
  snapshot: OntologySnapshot,
  recordLoad: (objectType: string, startAt: number, durationMs: number) => void,
): void {
  const links = snapshot.links;
  if (!links || links.size === 0) return;

  const specsByType = new Map<string, LinkAccessorSpec[]>();
  const push = (type: string, spec: LinkAccessorSpec): void => {
    const arr = specsByType.get(type);
    if (arr) arr.push(spec);
    else specsByType.set(type, [spec]);
  };
  for (const def of links.values()) {
    push(def.sourceType, {
      name: def.apiName,
      multi: isManySide(def.cardinality, "source"),
      edges: def.forward,
      targetType: def.targetType,
    });
    if (def.reverseApiName) {
      push(def.targetType, {
        name: def.reverseApiName,
        multi: isManySide(def.cardinality, "target"),
        edges: def.reverse,
        targetType: def.sourceType,
      });
    }
  }

  for (const [objectType, bucket] of snapshot.byType.entries()) {
    const specs = specsByType.get(objectType);
    if (!specs || specs.length === 0) continue;
    for (const obj of bucket.values()) {
      for (const spec of specs) {
        // Never shadow a real property; never throw on repeated decoration
        // of the same instance (configurable + skip-if-present).
        if (Object.prototype.hasOwnProperty.call(obj, spec.name)) continue;
        const accessor = spec.multi
          ? buildMultiLink(snapshot, spec, obj.$primaryKey, recordLoad)
          : buildSingleLink(snapshot, spec, obj.$primaryKey, recordLoad);
        Object.defineProperty(obj, spec.name, {
          value: accessor,
          writable: false,
          enumerable: false,
          configurable: true,
        });
      }
    }
  }
}

function buildSingleLink(
  snapshot: OntologySnapshot,
  spec: LinkAccessorSpec,
  ownerPk: string,
  recordLoad: (objectType: string, startAt: number, durationMs: number) => void,
): SingleLink {
  let cached: OntologyObject | undefined;
  let resolved = false;
  const resolve = (): OntologyObject | undefined => {
    if (!resolved) {
      const t0 = Date.now();
      const pks = spec.edges.get(ownerPk);
      const pk = pks && pks.length > 0 ? pks[0] : undefined;
      cached = pk === undefined
        ? undefined
        : snapshot.byType.get(spec.targetType)?.get(String(pk));
      recordLoad(spec.targetType, t0, Date.now() - t0);
      resolved = true;
    }
    return cached;
  };
  return { get: resolve, getAsync: () => Promise.resolve(resolve()) };
}

function buildMultiLink(
  snapshot: OntologySnapshot,
  spec: LinkAccessorSpec,
  ownerPk: string,
  recordLoad: (objectType: string, startAt: number, durationMs: number) => void,
): MultiLink {
  let cached: OntologyObject[] | undefined;
  const resolveAll = (): OntologyObject[] => {
    if (cached) return cached;
    const t0 = Date.now();
    const pks = spec.edges.get(ownerPk) ?? [];
    const bucket = snapshot.byType.get(spec.targetType);
    cached = pks
      .map((pk) => bucket?.get(String(pk)))
      .filter((o): o is OntologyObject => o !== undefined);
    recordLoad(spec.targetType, t0, Date.now() - t0);
    return cached;
  };
  return {
    all: () => resolveAll().slice(),
    allAsync: () => Promise.resolve(resolveAll().slice()),
    count: () => resolveAll().length,
    search: (where?: Record<string, unknown> | ((o: OntologyObject) => unknown)) => {
      const rows = resolveAll();
      const filtered =
        where === undefined || where === null
          ? rows
          : typeof where === "function"
            ? rows.filter((o) => Boolean(where(o)))
            : rows.filter((o) => matchesWhere(o, where));
      return asSearchable(new ObjectSet(filtered, spec.targetType, snapshot, recordLoad));
    },
  };
}

/**
 * Wrap an ObjectSet so generated `searchAroundTo<LinkName>()` pivots are
 * callable in addition to the generic `searchAround(linkApiName)`. Generated
 * names use the ontology's link API names with an upper-cased first letter —
 * `searchAroundToQARwandaBkloanapplications2()` etc. — matching how Foundry
 * generates `ObjectSet.searchAroundToXxx()` from link API names.
 */
function asSearchable(set: ObjectSet): ObjectSet {
  return new Proxy(set, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop.startsWith("searchAroundTo")) {
        const wanted = prop.slice("searchAroundTo".length);
        const apiName = target.resolveSearchAroundName(wanted);
        if (apiName !== undefined) {
          return () => target.searchAround(apiName);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function upperFirst(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// ObjectSet — a lazy-ish, chainable, synchronous query surface over a snapshot
// bucket. Mirrors the Foundry Functions read API (search / filter / aggregate)
// PLUS the link pivot ("search around") — Foundry docs §API: Objects and
// links: "You can traverse links as an ObjectSet to avoid loading linked
// object instances in the memory."
// ---------------------------------------------------------------------------
class ObjectSet {
  constructor(
    private readonly rows: OntologyObject[],
    private readonly objectType?: string,
    private readonly snapshot?: OntologySnapshot,
    private readonly recordLoad?: (objectType: string, startAt: number, durationMs: number) => void,
  ) {}
  all(): OntologyObject[] { return this.rows.slice(); }
  count(): number { return this.rows.length; }
  isEmpty(): boolean { return this.rows.length === 0; }
  first(): OntologyObject | undefined { return this.rows[0]; }
  take(n: number): ObjectSet { return asSearchable(new ObjectSet(this.rows.slice(0, Math.max(0, n | 0)), this.objectType, this.snapshot, this.recordLoad)); }
  filter(pred: (o: OntologyObject) => unknown): ObjectSet {
    return asSearchable(new ObjectSet(this.rows.filter((o) => Boolean(pred(o))), this.objectType, this.snapshot, this.recordLoad));
  }
  map<T>(fn: (o: OntologyObject) => T): T[] { return this.rows.map(fn); }
  orderBy(key: (o: OntologyObject) => number | string, dir: "asc" | "desc" = "asc"): ObjectSet {
    const sorted = this.rows.slice().sort((a, b) => {
      const ka = key(a), kb = key(b);
      const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
      return dir === "desc" ? -cmp : cmp;
    });
    return asSearchable(new ObjectSet(sorted, this.objectType, this.snapshot, this.recordLoad));
  }
  sum(field: string): number {
    return this.rows.reduce((acc, o) => acc + toNumber(o[field]), 0);
  }
  avg(field: string): number {
    return this.rows.length === 0 ? 0 : this.sum(field) / this.rows.length;
  }
  min(field: string): number | undefined {
    if (this.rows.length === 0) return undefined;
    return Math.min(...this.rows.map((o) => toNumber(o[field])));
  }
  max(field: string): number | undefined {
    if (this.rows.length === 0) return undefined;
    return Math.max(...this.rows.map((o) => toNumber(o[field])));
  }
  /** Group by a key function and count members per group. */
  groupByCount(key: (o: OntologyObject) => string | number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const o of this.rows) {
      const k = String(key(o));
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }
  /** Group by a key function and sum a numeric field per group. */
  groupBySum(key: (o: OntologyObject) => string | number, field: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const o of this.rows) {
      const k = String(key(o));
      out[k] = (out[k] ?? 0) + toNumber(o[field]);
    }
    return out;
  }

  /**
   * Pivot this set across a link type WITHOUT loading the linked instances
   * into memory first — Foundry parity for `objectSet.searchAroundToX()`.
   * `linkApiName` is the link's generated field name FROM this set's type:
   * the forward apiName when this set is the link's source type, the reverse
   * apiName when it is the target type.
   */
  searchAround(linkApiName: string): ObjectSet {
    const snapshot = this.snapshot;
    if (!snapshot?.links || !this.objectType) {
      return asSearchable(new ObjectSet([], undefined, snapshot, this.recordLoad));
    }
    let edges: ReadonlyMap<string, readonly string[]> | undefined;
    let targetType: string | undefined;
    for (const def of snapshot.links.values()) {
      if (def.sourceType === this.objectType && def.apiName === linkApiName) {
        edges = def.forward;
        targetType = def.targetType;
        break;
      }
      if (def.targetType === this.objectType && def.reverseApiName === linkApiName) {
        edges = def.reverse;
        targetType = def.sourceType;
        break;
      }
    }
    if (!edges || !targetType) {
      // Unknown link from this type — fail-silent (empty set), consistent
      // with the runtime's handling of non-imported object types.
      return asSearchable(new ObjectSet([], undefined, snapshot, this.recordLoad));
    }
    const t0 = Date.now();
    const bucket = snapshot.byType.get(targetType);
    const seen = new Set<string>();
    const out: OntologyObject[] = [];
    for (const o of this.rows) {
      const pks = edges.get(o.$primaryKey);
      if (!pks) continue;
      for (const pk of pks) {
        const key = String(pk);
        if (seen.has(key)) continue;
        seen.add(key);
        const target = bucket?.get(key);
        if (target) out.push(target);
      }
    }
    this.recordLoad?.(targetType, t0, Date.now() - t0);
    return asSearchable(new ObjectSet(out, targetType, snapshot, this.recordLoad));
  }

  /**
   * Resolve a generated `searchAroundTo<Name>` method name back to the link
   * apiName it was generated from (for this set's object type), or undefined
   * when no imported link matches.
   */
  resolveSearchAroundName(generatedName: string): string | undefined {
    const snapshot = this.snapshot;
    if (!snapshot?.links || !this.objectType) return undefined;
    for (const def of snapshot.links.values()) {
      if (def.sourceType === this.objectType && upperFirst(def.apiName) === generatedName) {
        return def.apiName;
      }
      if (
        def.reverseApiName !== null &&
        def.targetType === this.objectType &&
        upperFirst(def.reverseApiName) === generatedName
      ) {
        return def.reverseApiName;
      }
    }
    return undefined;
  }
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
}

/**
 * Wire-boundary type guard: `v` is a returned ObjectSet. The invoke route
 * uses this to serialize the set as its row ARRAY instead of the internal
 * `{"rows":[...]}` representation — Palantir's public surface exposes object
 * collections as plain arrays (`data` in the REST/Ontology API), never with
 * an internal `rows` key.
 */
export function isObjectSet(v: unknown): v is ObjectSet {
  return v instanceof ObjectSet;
}

// ---------------------------------------------------------------------------
// createEditBatch — Foundry TypeScript Functions v2 Ontology-edits API.
// (https://www.palantir.com/docs/foundry/functions/typescript-v2-ontology-edits)
//
// A function builds a batch and returns `batch.getEdits()`. Edits are NOT
// applied during execution (in-function reads see PRE-edit state); they only
// persist when the function is run through a function-backed Action (our
// `applyEdits`, invoked with applyEdits=true). All edits are collapsed into the
// minimal set on getEdits() — create+update → one create, create+delete → drop,
// link+unlink → unlink — mirroring Foundry's edit collapsing.
// ---------------------------------------------------------------------------

/** A reference to an object — an instance, or `{$apiName,$primaryKey}` / `{$objectType,$primaryKey}`. */
type ObjectRef = OntologyObject | { $apiName?: string; $objectType?: string; $primaryKey: unknown; [k: string]: unknown };
/** A reference to an object type — its apiName string, or a `{apiName}`/`{$objectType}` descriptor. */
type TypeRef = string | { apiName?: string; $apiName?: string; $objectType?: string };

function resolveTypeRef(type: TypeRef): string {
  if (typeof type === "string") return type;
  if (type && typeof type === "object") {
    const n = type.apiName ?? type.$apiName ?? type.$objectType;
    if (typeof n === "string" && n.length > 0) return n;
  }
  throw new Error("createEditBatch: invalid object-type reference");
}
function resolveObjectRef(ref: ObjectRef): { objectType: string; primaryKey: string } {
  if (ref && typeof ref === "object") {
    const r = ref as Record<string, unknown>;
    const objectType = r.$apiName ?? r.$objectType ?? r.apiName;
    const primaryKey = r.$primaryKey ?? r.primaryKey;
    if (typeof objectType === "string" && primaryKey !== undefined && primaryKey !== null) {
      return { objectType, primaryKey: String(primaryKey) };
    }
  }
  throw new Error("createEditBatch: invalid object reference — pass an object or { $apiName, $primaryKey }");
}

export interface EditBatch {
  /** Create an object. `props.$objectType` (interface create) overrides `type`. */
  create(type: TypeRef, props: Record<string, unknown> & { $primaryKey?: unknown; $objectType?: string }): void;
  /** Update an object's properties. `patch` may be a props object OR another object (copy-all). */
  update(ref: ObjectRef, patch: Record<string, unknown> | OntologyObject): void;
  /** Delete an object. */
  delete(ref: ObjectRef): void;
  /** Link two objects over a (many-to-many) link type. */
  link(source: ObjectRef, linkName: string, target: ObjectRef): void;
  /** Remove a link between two objects. */
  unlink(source: ObjectRef, linkName: string, target: ObjectRef): void;
  /** The collapsed, minimal set of edits — return this from the function. */
  getEdits(): OntologyEdit[];
}

/** Collapse a sequence of edits into the minimal set (Foundry parity). */
function collapseEdits(raw: ReadonlyArray<OntologyEdit>): OntologyEdit[] {
  const objects = new Map<string, OntologyEdit>();
  const order: string[] = [];
  const links = new Map<string, OntologyEdit>();
  const okey = (t: string, pk: string) => `${t}\u0000${pk}`;
  for (const e of raw) {
    if (e.op === "link" || e.op === "unlink") {
      links.set(`${e.linkType}\u0000${e.sourcePrimaryKey}\u0000${e.targetPrimaryKey}`, e); // last wins
      continue;
    }
    const k = okey(e.objectType, e.primaryKey);
    const cur = objects.get(k);
    if (!cur) order.push(k);
    if (e.op === "create") {
      objects.set(k, e);
    } else if (e.op === "update") {
      if (cur?.op === "create") objects.set(k, { ...cur, properties: { ...cur.properties, ...e.patch } });
      else if (cur?.op === "update") objects.set(k, { ...cur, patch: { ...cur.patch, ...e.patch } });
      else if (cur?.op === "delete") { /* update after delete is a no-op */ }
      else objects.set(k, e);
    } else { // delete
      if (cur?.op === "create") objects.delete(k); // create+delete cancel out
      else objects.set(k, e);
    }
  }
  const out: OntologyEdit[] = [];
  for (const k of order) { const v = objects.get(k); if (v) out.push(v); }
  for (const v of links.values()) out.push(v);
  return out;
}

export function createEditBatchImpl(): EditBatch {
  const raw: OntologyEdit[] = [];
  return {
    create(type, props) {
      const p = { ...(props ?? {}) } as Record<string, unknown>;
      const interfaceType = typeof p.$objectType === "string" ? undefined : undefined;
      const objectType = typeof p.$objectType === "string" ? p.$objectType : resolveTypeRef(type);
      const declaredInterface = typeof p.$objectType === "string" ? resolveTypeRef(type) : undefined;
      const pk = p.$primaryKey ?? p.primaryKey;
      const primaryKey = pk !== undefined && pk !== null ? String(pk) : cryptoRandomId();
      delete p.$primaryKey; delete p.primaryKey; delete p.$objectType;
      void interfaceType;
      raw.push(declaredInterface
        ? { op: "create", objectType, primaryKey, properties: p, interfaceType: declaredInterface }
        : { op: "create", objectType, primaryKey, properties: p });
    },
    update(ref, patch) {
      const { objectType, primaryKey } = resolveObjectRef(ref);
      let p: Record<string, unknown>;
      if (patch && typeof patch === "object" && ("$primaryKey" in patch || "$apiName" in patch)) {
        // copy-all: `patch` is another object instance — copy its declared props.
        p = Object.fromEntries(Object.entries(patch).filter(([k]) => !k.startsWith("$")));
      } else {
        p = { ...((patch as Record<string, unknown>) ?? {}) };
      }
      raw.push({ op: "update", objectType, primaryKey, patch: p });
    },
    delete(ref) {
      const { objectType, primaryKey } = resolveObjectRef(ref);
      raw.push({ op: "delete", objectType, primaryKey });
    },
    link(source, linkName, target) {
      const s = resolveObjectRef(source);
      const t = resolveObjectRef(target);
      raw.push({ op: "link", linkType: String(linkName), sourcePrimaryKey: s.primaryKey, targetPrimaryKey: t.primaryKey });
    },
    unlink(source, linkName, target) {
      const s = resolveObjectRef(source);
      const t = resolveObjectRef(target);
      raw.push({ op: "unlink", linkType: String(linkName), sourcePrimaryKey: s.primaryKey, targetPrimaryKey: t.primaryKey });
    },
    getEdits() {
      return collapseEdits(raw);
    },
  };
}

// ---------------------------------------------------------------------------
// The injectable SDK + edit collector.
// ---------------------------------------------------------------------------
export interface OntologySdk {
  readonly Objects: {
    search(objectType: string): ObjectSet;
    get(objectType: string, primaryKey: string): OntologyObject | undefined;
    types(): string[];
  };
  readonly Edits: {
    create(objectType: string, properties: Record<string, unknown> & { primaryKey?: string }): void;
    update(objectType: string, primaryKey: string, patch: Record<string, unknown>): void;
    delete(objectType: string, primaryKey: string): void;
    getEdits(): OntologyEdit[];
  };
  /** Foundry TS v2 edits API: `const batch = createEditBatch(client)`. */
  createEditBatch(): EditBatch;
  /** Object-type descriptors, exposed as the `@ontology/sdk` module. */
  readonly objectTypeDescriptors: Record<string, { apiName: string }>;
}

/**
 * Per-object-type access timing accumulated during execution — one entry per
 * object TYPE (not per call), so a function calling `Objects.get` in a loop
 * yields a single aggregated record (`calls` keeps the multiplicity).
 *
 * Accuracy note: snapshot reads are in-memory `Map.get`s — the real loading
 * I/O happened at snapshot build time (tracked by the route's
 * "Load ontology snapshot" phase). These timings measure the cost of the
 * materialisation + property bind per access from the function's perspective,
 * which is the in-executor counterpart of Foundry's "Load objects from
 * arguments/links" waterfall bars. Timestamps are wall-clock `Date.now()`
 * (NOT `performance.now()`) so offsets are comparable across worker threads
 * (each worker has its own perf-hooks time origin).
 */
export interface ObjectLoadTiming {
  readonly objectType: string;
  readonly calls: number;
  /** Wall-clock timestamp of the FIRST access to this type. */
  readonly firstStartAt: number;
  /** Wall-clock timestamp of the LAST access START to this type. */
  readonly lastStartAt: number;
  /** Cumulative time spent inside search/get for this type. */
  readonly totalDurationMs: number;
}

export interface BuiltSdk {
  readonly sdk: OntologySdk;
  /** The edits collected during execution (read after the function returns). */
  getEdits(): OntologyEdit[];
  /**
   * The object types the function QUERIED via `Objects.search`/`Objects.get`
   * during execution — read after the function returns. The invoke route
   * diffs this against the repo's imported object types to surface an
   * actionable "accessed but not imported" warning (the runtime enforces
   * imports fail-silently: a non-imported type yields an empty `ObjectSet`,
   * so without this record the user sees an unexplained empty result).
   * `Objects.types()` is NOT recorded — it lists loaded types, not a request.
   */
  getRequestedTypes(): string[];
  /** Per-type access timings (performance.phases source). */
  getObjectLoads(): ObjectLoadTiming[];
}

export function buildOntologySdk(snapshot: OntologySnapshot): BuiltSdk {
  const edits: OntologyEdit[] = [];
  // Every object type the function asked `Objects.search`/`Objects.get` for.
  // Insertion-ordered; duplicates collapse (a Set). Read post-run by the
  // worker and threaded back to the invoke route for the import diff.
  const requestedTypes = new Set<string>();
  const objectLoads = new Map<
    string,
    { calls: number; firstStartAt: number; lastStartAt: number; totalDurationMs: number }
  >();
  const recordLoad = (objectType: string, startAt: number, durationMs: number): void => {
    const prev = objectLoads.get(objectType);
    if (prev) {
      prev.calls += 1;
      prev.lastStartAt = startAt;
      prev.totalDurationMs += durationMs;
    } else {
      objectLoads.set(objectType, { calls: 1, firstStartAt: startAt, lastStartAt: startAt, totalDurationMs: durationMs });
    }
  };
  // Attach generated Link Type accessors (SingleLink `.get()` on the `1`
  // side, MultiLink `.all()` on the `many` side) to every snapshot object
  // the imported link types touch — ONCE per execution. This runs inside the
  // worker (accessors are functions and cannot cross postMessage with the
  // snapshot), and decorates the SAME object instances that argument
  // hydration returns, so link traversal works identically on function
  // parameters, `Objects.get` results, search results, and nested hops.
  attachLinkAccessors(snapshot, recordLoad);
  const sdk: OntologySdk = {
    Objects: {
      search(objectType: string): ObjectSet {
        const startAt = Date.now();
        requestedTypes.add(String(objectType));
        const bucket = snapshot.byType.get(objectType);
        // asSearchable: generated `searchAroundToX()` alongside the generic
        // `searchAround(link)` — Foundry's ObjectSet link-pivot surface.
        const out = asSearchable(
          new ObjectSet(
            bucket ? [...bucket.values()] : [],
            String(objectType),
            snapshot,
            recordLoad,
          ),
        );
        recordLoad(String(objectType), startAt, Date.now() - startAt);
        return out;
      },
      get(objectType: string, primaryKey: string): OntologyObject | undefined {
        const startAt = Date.now();
        requestedTypes.add(String(objectType));
        const out = snapshot.byType.get(objectType)?.get(String(primaryKey));
        recordLoad(String(objectType), startAt, Date.now() - startAt);
        return out;
      },
      types(): string[] {
        return [...snapshot.byType.keys()];
      },
    },
    Edits: {
      create(objectType, properties) {
        const pk = String(properties.primaryKey ?? properties.$primaryKey ?? cryptoRandomId());
        const { primaryKey: _pk, $primaryKey: _pk2, ...rest } = properties as Record<string, unknown>;
        void _pk; void _pk2;
        edits.push({ op: "create", objectType, primaryKey: pk, properties: rest });
      },
      update(objectType, primaryKey, patch) {
        edits.push({ op: "update", objectType, primaryKey: String(primaryKey), patch: { ...patch } });
      },
      delete(objectType, primaryKey) {
        edits.push({ op: "delete", objectType, primaryKey: String(primaryKey) });
      },
      getEdits() { return edits.slice(); },
    },
    createEditBatch: () => createEditBatchImpl(),
    // Descriptors are keyed off the repo's DECLARED imports
    // (`snapshot.importedTypes`), NOT the types that happen to have rows
    // (`snapshot.objectTypes`). A generated `@ontology/sdk` exposes every
    // imported type regardless of instance count, so a function may read
    // `SomeType.apiName` for a type with zero rows in this snapshot — that
    // must resolve to `{ apiName }` (it is a TYPE descriptor, not data), else
    // `import { SomeType } from "@ontology/sdk"` is `undefined` in the sandbox
    // and `SomeType.apiName` throws `Cannot read properties of undefined`.
    //
    // Use DECLARED imports only when NON-EMPTY (not `??`): an empty
    // `importedTypes: []` must NOT shadow real rows loaded by an unfiltered
    // `loadOntologySnapshot` call — `[]` is non-nullish, so `??` would wrongly
    // pick it and yield an empty descriptor map. The non-empty guard preserves
    // the pre-fix behaviour (descriptors = loaded types) for that edge case +
    // for callers that load without an import filter.
    objectTypeDescriptors: Object.fromEntries(
      (snapshot.importedTypes && snapshot.importedTypes.length > 0
        ? snapshot.importedTypes
        : snapshot.objectTypes
      ).map((t) => [t, { apiName: t }]),
    ),
  };
  return {
    sdk,
    getEdits: () => edits.slice(),
    getRequestedTypes: () => [...requestedTypes],
    getObjectLoads: () =>
      [...objectLoads.entries()].map(([objectType, t]) => ({
        objectType,
        calls: t.calls,
        firstStartAt: t.firstStartAt,
        lastStartAt: t.lastStartAt,
        totalDurationMs: t.totalDurationMs,
      })),
  };
}

function cryptoRandomId(): string {
  // Deterministic-enough unique id for created objects without pulling crypto
  // into the sandbox. Host-side only.
  return "obj-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// applyEdits — persist a collected edit batch (simulating a function-backed
// Action). Writes the system-of-record `object_instances`, the Funnel edit
// store `ontology_edit` (the rows every reindex/funnel pass replays — without
// them a force reindex silently reverts function-applied properties to the
// datasource baseline), and, for property updates, an audit row in
// `object_edits`. Idempotent-ish and transactional.
// ---------------------------------------------------------------------------
export interface ApplyEditsArgs {
  readonly ontologyId: string;
  readonly edits: readonly OntologyEdit[];
  readonly actorUserId?: string | null;
  /** Action context for edit-store provenance (`ontology_edit.action_type_api_name`).
   * Optional: function-preview/invoke callers omit it. */
  readonly actionTypeApiName?: string | null;
  /** Execution uuid for edit-store provenance (`ontology_edit.execution_id`). */
  readonly executionId?: string | null;
  /** Function-backed Actions use this to append their audit row in the same
   * transaction as the ontology mutations. Preview/invoke callers omit it. */
  readonly preCommitHook?: (client: PoolClient) => Promise<void>;
}
export interface ApplyEditsResult {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly linked: number;
  readonly unlinked: number;
}

export async function applyEdits(pool: Pool, args: ApplyEditsArgs): Promise<ApplyEditsResult> {
  // Preview callers can return immediately for an empty batch. Action callers
  // still need a transaction so their pre-commit audit hook runs for a
  // successful no-op Function invocation.
  if (args.edits.length === 0 && !args.preCommitHook) {
    return { created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0 };
  }
  const client: PoolClient = await pool.connect();
  let created = 0, updated = 0, deleted = 0, linked = 0, unlinked = 0;
  const editBatchId = randomUUID();
  // Function-backed Actions historically bypassed editApplicator's B7
  // writeback overlay. PostgreSQL advanced immediately, but object search
  // continued returning the older indexed document. Collect the committed
  // post-edit projections here and publish them only after COMMIT, preventing
  // both stale reads and phantom overlay records on rollback.
  const committedOverlays: OverlayRecord[] = [];
  try {
    await client.query("BEGIN");
    const linkTablePresent = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('link_edit') IS NOT NULL AS exists`,
    );
    const canLink = linkTablePresent.rows[0]?.exists === true;
    // Resolve a branch_id to write under (object_instances.branch_id is NOT NULL
    // post-migration 041). Reuse the ontology's existing branch, else default.
    const br = await client.query<{ branch_id: string }>(
      `SELECT branch_id FROM object_instances WHERE ontology_id = $1::uuid LIMIT 1`,
      [args.ontologyId],
    );
    const branchId = br.rows[0]?.branch_id ?? "00000000-0000-0000-0000-000000000000";

    const auditTablePresent = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('object_edits') IS NOT NULL AS exists`,
    );
    const canAudit = auditTablePresent.rows[0]?.exists === true;
    // The Funnel edit store: pending + persistent rows here are what the
    // reindex/funnel pipeline replays over datasource snapshots. Function
    // edits MUST land here or they are silently reverted on the next reindex
    // (parity with editApplicator's B1 contract for declarative Actions).
    const editStorePresent = await client.query<{ exists: boolean }>(
      `SELECT to_regclass('ontology_edit') IS NOT NULL AS exists`,
    );
    const canEditStore = editStorePresent.rows[0]?.exists === true;
    // One edit-store row per create/update/delete edit (NOT per property):
    // property_values carries the same payload a declarative wiring writes —
    // the full document for creates, the patch subset for updates, `{}` for
    // deletes — so replay engines overlay per property uniformly.
    const insertEditStoreRow = async (
      e: Extract<OntologyEdit, { op: "create" | "update" | "delete" }>,
    ): Promise<void> => {
      if (!canEditStore) return;
      const properties =
        e.op === "create" ? (e.properties ?? {}) :
        e.op === "update" ? (e.patch ?? {}) :
        {};
      await client.query(
        `INSERT INTO ontology_edit
           (object_type_api_name, primary_key, operation, property_values,
            action_type_api_name, execution_id, executed_by, edit_strategy,
            ontology_id, branch_id)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, 'user_edit_wins', $8::uuid, $9::uuid)`,
        [
          e.objectType,
          e.primaryKey,
          e.op,
          JSON.stringify(properties),
          args.actionTypeApiName ?? null,
          args.executionId && UUID_RE.test(args.executionId) ? args.executionId : null,
          args.actorUserId ?? "system",
          args.ontologyId,
          branchId,
        ],
      );
    };

    for (const e of args.edits) {
      if (e.op === "create") {
        const r = await client.query<{ properties: Record<string, unknown>; version: number; rid: string | null }>(
          `INSERT INTO object_instances
             (ontology_id, branch_id, object_type_api_name, primary_key, properties, last_modified_at, version)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, now(), 1)
           ON CONFLICT (ontology_id, branch_id, object_type_api_name, primary_key)
           DO UPDATE SET properties = EXCLUDED.properties, last_modified_at = now(),
                         version = object_instances.version + 1
           RETURNING properties, version, rid`,
          [args.ontologyId, branchId, e.objectType, e.primaryKey, JSON.stringify(e.properties)],
        );
        const row = r.rows[0];
        if (row) committedOverlays.push({
          branchId: "_main",
          objectType: e.objectType,
          primaryKey: e.primaryKey,
          doc: { ...row.properties, ...(row.rid ? { __rid: row.rid } : {}) },
          deleted: false,
          version: Number(row.version),
          createdAt: Date.now(),
          editId: randomUUID(),
          actorUserId: args.actorUserId ?? null,
        });
        // Persist the edit WAL row so the serving projector / funnel / reindex
        // replay see function-created objects (parity with editApplicator B1).
        await insertEditStoreRow(e);
        created += 1;
      } else if (e.op === "update") {
        const r = await client.query<{ properties: Record<string, unknown>; version: number; rid: string | null }>(
          `UPDATE object_instances
              SET properties = properties || $5::jsonb, last_modified_at = now(),
                  version = version + 1
            WHERE ontology_id = $1::uuid AND branch_id = $2::uuid
              AND object_type_api_name = $3 AND primary_key = $4
          RETURNING properties, version, rid`,
          [args.ontologyId, branchId, e.objectType, e.primaryKey, JSON.stringify(e.patch)],
        );
        updated += r.rowCount ?? 0;
        await insertEditStoreRow(e);
        const row = r.rows[0];
        if (row) committedOverlays.push({
          branchId: "_main",
          objectType: e.objectType,
          primaryKey: e.primaryKey,
          doc: { ...row.properties, ...(row.rid ? { __rid: row.rid } : {}) },
          deleted: false,
          version: Number(row.version),
          createdAt: Date.now(),
          editId: randomUUID(),
          actorUserId: args.actorUserId ?? null,
        });
        if (canAudit) {
          for (const [prop, val] of Object.entries(e.patch)) {
            await client.query(
              `INSERT INTO object_edits
                 (ontology_id, object_type_api_name, primary_key, property_api_name, new_value, actor_user_id)
               VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6)`,
              [args.ontologyId, e.objectType, e.primaryKey, prop, JSON.stringify(val ?? null),
               args.actorUserId && UUID_RE.test(args.actorUserId) ? args.actorUserId : null],
            );
          }
        }
      } else if (e.op === "delete") {
        const r = await client.query<{ version: number }>(
          `DELETE FROM object_instances
            WHERE ontology_id = $1::uuid AND branch_id = $2::uuid
              AND object_type_api_name = $3 AND primary_key = $4
          RETURNING version`,
          [args.ontologyId, branchId, e.objectType, e.primaryKey],
        );
        deleted += r.rowCount ?? 0;
        if ((r.rowCount ?? 0) > 0) await insertEditStoreRow(e);
        const row = r.rows[0];
        if (row) committedOverlays.push({
          branchId: "_main",
          objectType: e.objectType,
          primaryKey: e.primaryKey,
          doc: {},
          deleted: true,
          // A delete is the next state transition after the removed row.
          version: Number(row.version) + 1,
          createdAt: Date.now(),
          editId: randomUUID(),
          actorUserId: args.actorUserId ?? null,
        });
      } else {
        // link / unlink → an append-only edit in link_edit (operation add|remove).
        if (canLink) {
          await client.query(
            `INSERT INTO link_edit
               (link_type_api_name, source_primary_key, target_primary_key,
                ontology_id, branch_id, operation, actor_principal_id, executed_at)
             VALUES ($1, $2, $3, $4::uuid, $5::uuid, $6, $7, now())`,
            [e.linkType, e.sourcePrimaryKey, e.targetPrimaryKey, args.ontologyId, branchId,
             e.op === "link" ? "add" : "remove", args.actorUserId ?? null],
          );
        }
        if (e.op === "link") linked += 1; else unlinked += 1;
      }
    }
    // Wake the durable Funnel in the SAME transaction as the object edits.
    // This is the long-term projection path; the overlay below only provides
    // immediate read-your-writes while indexing is in flight. A rollback
    // removes both mutations and signals, so no phantom reindex can escape.
    const affectedTypes = new Set(
      args.edits.flatMap((edit) =>
        "objectType" in edit && typeof edit.objectType === "string"
          ? [edit.objectType]
          : [],
      ),
    );
    for (const objectTypeApiName of affectedTypes) {
      await sendSignal({
        ontologyId: args.ontologyId,
        objectTypeApiName,
        signalType: "editBatchPending",
        fingerprint: `function-edit:${editBatchId}:${objectTypeApiName}`,
        payload: { source: "function-action", editBatchId },
        client,
      });
    }
    if (args.preCommitHook) await args.preCommitHook(client);
    await client.query("COMMIT");
    if (committedOverlays.length > 0) {
      try {
        const store = await getOverlayStore();
        const commitTimeout = Number(process.env.QUICKWIT_COMMIT_TIMEOUT_SECS ?? 60);
        const ttlSeconds = Math.max(60, (Number.isFinite(commitTimeout) ? commitTimeout : 60) * 3);
        await Promise.all(
          committedOverlays.map((record) => writeOverlay(record, store, ttlSeconds)),
        );
      } catch (error) {
        // PostgreSQL is authoritative and the durable indexing pipeline still
        // consumes object_edits. Overlay failure must not turn a committed
        // Action into a reported failure, but it must be observable.
        console.warn(
          `[function-edits] post-commit overlay publish failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { created, updated, deleted, linked, unlinked };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
