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

import type { Pool, PoolClient } from "pg";

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

export interface OntologySnapshot {
  /** objectTypeApiName → (primaryKey → object). */
  readonly byType: Map<string, Map<string, OntologyObject>>;
  readonly ontologyId: string;
  readonly objectCount: number;
  readonly objectTypes: readonly string[];
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
    const props = r.properties ?? {};
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
  return { byType, ontologyId: args.ontologyId, objectCount: count, objectTypes: [...byType.keys()] };
}

// ---------------------------------------------------------------------------
// ObjectSet — a lazy-ish, chainable, synchronous query surface over a snapshot
// bucket. Mirrors the Foundry Functions read API (search / filter / aggregate).
// ---------------------------------------------------------------------------
class ObjectSet {
  constructor(private readonly rows: OntologyObject[]) {}
  all(): OntologyObject[] { return this.rows.slice(); }
  count(): number { return this.rows.length; }
  isEmpty(): boolean { return this.rows.length === 0; }
  first(): OntologyObject | undefined { return this.rows[0]; }
  take(n: number): ObjectSet { return new ObjectSet(this.rows.slice(0, Math.max(0, n | 0))); }
  filter(pred: (o: OntologyObject) => unknown): ObjectSet {
    return new ObjectSet(this.rows.filter((o) => Boolean(pred(o))));
  }
  map<T>(fn: (o: OntologyObject) => T): T[] { return this.rows.map(fn); }
  orderBy(key: (o: OntologyObject) => number | string, dir: "asc" | "desc" = "asc"): ObjectSet {
    const sorted = this.rows.slice().sort((a, b) => {
      const ka = key(a), kb = key(b);
      const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
      return dir === "desc" ? -cmp : cmp;
    });
    return new ObjectSet(sorted);
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
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
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
  const okey = (t: string, pk: string) => `${t} ${pk}`;
  for (const e of raw) {
    if (e.op === "link" || e.op === "unlink") {
      links.set(`${e.linkType} ${e.sourcePrimaryKey} ${e.targetPrimaryKey}`, e); // last wins
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

export interface BuiltSdk {
  readonly sdk: OntologySdk;
  /** The edits collected during execution (read after the function returns). */
  getEdits(): OntologyEdit[];
}

export function buildOntologySdk(snapshot: OntologySnapshot): BuiltSdk {
  const edits: OntologyEdit[] = [];
  const sdk: OntologySdk = {
    Objects: {
      search(objectType: string): ObjectSet {
        const bucket = snapshot.byType.get(objectType);
        return new ObjectSet(bucket ? [...bucket.values()] : []);
      },
      get(objectType: string, primaryKey: string): OntologyObject | undefined {
        return snapshot.byType.get(objectType)?.get(String(primaryKey));
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
    objectTypeDescriptors: Object.fromEntries(
      snapshot.objectTypes.map((t) => [t, { apiName: t }]),
    ),
  };
  return { sdk, getEdits: () => edits.slice() };
}

function cryptoRandomId(): string {
  // Deterministic-enough unique id for created objects without pulling crypto
  // into the sandbox. Host-side only.
  return "obj-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------------------------------------------------------------------------
// applyEdits — persist a collected edit batch (simulating a function-backed
// Action). Writes the system-of-record `object_instances` and, for property
// updates, an audit row in `object_edits`. Idempotent-ish and transactional.
// ---------------------------------------------------------------------------
export interface ApplyEditsArgs {
  readonly ontologyId: string;
  readonly edits: readonly OntologyEdit[];
  readonly actorUserId?: string | null;
}
export interface ApplyEditsResult {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly linked: number;
  readonly unlinked: number;
}

export async function applyEdits(pool: Pool, args: ApplyEditsArgs): Promise<ApplyEditsResult> {
  if (args.edits.length === 0) return { created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0 };
  const client: PoolClient = await pool.connect();
  let created = 0, updated = 0, deleted = 0, linked = 0, unlinked = 0;
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

    for (const e of args.edits) {
      if (e.op === "create") {
        await client.query(
          `INSERT INTO object_instances
             (ontology_id, branch_id, object_type_api_name, primary_key, properties, last_modified_at, version)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, now(), 1)
           ON CONFLICT (ontology_id, branch_id, object_type_api_name, primary_key)
           DO UPDATE SET properties = EXCLUDED.properties, last_modified_at = now(),
                         version = object_instances.version + 1`,
          [args.ontologyId, branchId, e.objectType, e.primaryKey, JSON.stringify(e.properties)],
        );
        created += 1;
      } else if (e.op === "update") {
        const r = await client.query(
          `UPDATE object_instances
              SET properties = properties || $5::jsonb, last_modified_at = now(),
                  version = version + 1
            WHERE ontology_id = $1::uuid AND branch_id = $2::uuid
              AND object_type_api_name = $3 AND primary_key = $4`,
          [args.ontologyId, branchId, e.objectType, e.primaryKey, JSON.stringify(e.patch)],
        );
        updated += r.rowCount ?? 0;
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
        const r = await client.query(
          `DELETE FROM object_instances
            WHERE ontology_id = $1::uuid AND branch_id = $2::uuid
              AND object_type_api_name = $3 AND primary_key = $4`,
          [args.ontologyId, branchId, e.objectType, e.primaryKey],
        );
        deleted += r.rowCount ?? 0;
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
    await client.query("COMMIT");
    return { created, updated, deleted, linked, unlinked };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
