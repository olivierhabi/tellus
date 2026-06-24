// Workshop B06 — OMS metadata facade with TTL cache.
//
// Spec: tasks/workshop/workshop-tasks.md §B06.
// Decision D-04 (no Redis; in-process LRU + Postgres NOTIFY for now).
// D-02 (in-process services — wraps the existing object_type and
// action_type tables that the monolith maintains).
//
// Surface (used by B07/B08/B09 + the F01 picker):
//   listObjectTypes(ontologyRid)            → ObjectTypeMetadata[]
//   getObjectType(ontologyRid, idOrApiName) → ObjectTypeMetadata
//   listActionTypes(ontologyRid)            → ActionTypeMetadata[]
//   getActionType(ontologyRid, idOrApiName) → ActionTypeMetadata
//   invalidate(ontologyRid)                 → drops all entries for ontology
//
// SLO: cache-hit P95 ≤ 60ms (single-Map lookup), cache-miss P95 ≤ 400ms
// (one indexed SELECT). Eventual consistency is bounded by `ttlMs` (30s
// per spec).

import { getWorkshopDb } from "./db";
import {
  objectTypeNotFound,
  actionTypeNotFound,
  ontologyNotFound,
} from "./errors";
import { histOmsLookup, counterOmsCacheHit } from "./metrics";

async function instrumentOms<T>(
  kind: "object_type_list" | "object_type_get" | "action_type_list" | "action_type_get",
  cacheLabel: "hit" | "miss",
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = process.hrtime.bigint();
  let result: "success" | "error" = "success";
  try {
    const out = await fn();
    counterOmsCacheHit.inc({ kind, result: cacheLabel }, 1);
    return out;
  } catch (e) {
    result = "error";
    throw e;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histOmsLookup.observe({ kind, result }, ns / 1e9);
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ObjectTypeMetadata {
  id: string;
  ontologyId: string;
  apiName: string;
  displayName: string;
  description: string;
  primaryKey: string[];
  properties: Array<{
    apiName: string;
    type: string;
    nullable: boolean;
    displayName?: string;
    description?: string;
  }>;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActionTypeMetadata {
  id: string;
  ontologyId: string;
  apiName: string;
  displayName: string;
  description: string;
  parameters: unknown[];
  rules: unknown[];
  submissionCriteria: unknown | null;
  isEnabled: boolean;
  maxAffectedObjects: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface Entry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache<K, V> {
  private map = new Map<K, Entry<V>>();
  private hits = 0;
  private misses = 0;
  constructor(private ttlMs: number) {}

  get(key: K): V | null {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.value;
  }

  put(key: K, value: V) {
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: K) {
    this.map.delete(key);
  }

  // Bulk invalidation by predicate; used when an ontology-scope invalidation
  // arrives (e.g. via NOTIFY).
  deleteWhere(pred: (key: K) => boolean) {
    for (const k of this.map.keys()) {
      if (pred(k)) this.map.delete(k);
    }
  }

  reset() {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats() {
    return { hits: this.hits, misses: this.misses, size: this.map.size };
  }

  setTtl(ms: number) {
    this.ttlMs = ms;
  }
}

// One cache for object-type lookups, keyed by `${ontology}|listAll` for
// list endpoints and `${ontology}|byId|${id}` for single lookups so the
// invalidate step can wipe both list+singletons in a single sweep.
const cache = new TtlCache<string, ObjectTypeMetadata | ObjectTypeMetadata[] | ActionTypeMetadata | ActionTypeMetadata[]>(30_000);

export const omsCache = cache;

export function invalidateOntology(ontologyRid: string): void {
  cache.deleteWhere((k) => k.startsWith(`${ontologyRid}|`));
}

// ---------------------------------------------------------------------------
// Object type lookups
// ---------------------------------------------------------------------------

interface ObjectTypeRow {
  object_type_id: string;
  ontology_id: string;
  api_name: string;
  display_name: string;
  description: string | null;
  primary_key_property_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function rowToObjectType(row: ObjectTypeRow): ObjectTypeMetadata {
  return {
    id: row.object_type_id,
    ontologyId: row.ontology_id,
    apiName: row.api_name,
    displayName: row.display_name,
    description: row.description ?? "",
    primaryKey: row.primary_key_property_id ? [row.primary_key_property_id] : [],
    properties: [],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Extract a UUID from a Tellus RID. Tellus RIDs are
 *   `ri.<service>.<instance>.<type>.<uuid>`
 * The `object_type` and `ontology` tables in the live monorepo store
 * `ontology_id` as a `uuid` column rather than as a RID, so workshop
 * callers passing a RID need to be unwrapped before the lookup.
 *
 * If `value` already looks like a bare UUID we return it unchanged.
 */
function ridToUuid(value: string): string {
  const uuidRe =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  if (/^[0-9a-f-]{36}$/i.test(value)) return value;
  const match = value.match(uuidRe);
  if (match) return match[0];
  // Fall through unchanged — let the database surface the type error
  // rather than silently mangling unexpected input.
  return value;
}

export async function listObjectTypes(
  ontologyRid: string,
): Promise<ObjectTypeMetadata[]> {
  const key = `${ontologyRid}|ot|listAll`;
  const cached = cache.get(key);
  if (cached) {
    return await instrumentOms("object_type_list", "hit", async () => cached as ObjectTypeMetadata[]);
  }
  return await instrumentOms("object_type_list", "miss", async () => {
  const db = getWorkshopDb();
  const r = await db.query(
    `SELECT object_type_id, ontology_id, api_name, display_name,
            description, primary_key_property_id, status,
            created_at::text, updated_at::text
       FROM object_type
      WHERE ontology_id = $1::uuid
   ORDER BY api_name`,
    [ridToUuid(ontologyRid)],
  );
  const list = (r.rows as ObjectTypeRow[]).map(rowToObjectType);
  cache.put(key, list);
  return list;
  });
}

export async function getObjectType(
  ontologyRid: string,
  idOrApiName: string,
): Promise<ObjectTypeMetadata> {
  const key = `${ontologyRid}|ot|id|${idOrApiName}`;
  const cached = cache.get(key);
  if (cached) {
    return await instrumentOms("object_type_get", "hit", async () => cached as ObjectTypeMetadata);
  }
  return await instrumentOms("object_type_get", "miss", async () => {
  const db = getWorkshopDb();
  const r = await db.query(
    `SELECT object_type_id, ontology_id, api_name, display_name,
            description, primary_key_property_id, status,
            created_at::text, updated_at::text
       FROM object_type
      WHERE ontology_id = $1::uuid
        AND (object_type_id::text = $2 OR api_name = $2)
      LIMIT 1`,
    [ridToUuid(ontologyRid), idOrApiName],
  );
  if (r.rows.length === 0) {
    throw objectTypeNotFound(ontologyRid, idOrApiName);
  }
  const meta = rowToObjectType(r.rows[0] as ObjectTypeRow);
  cache.put(key, meta);
  return meta;
  });
}

// ---------------------------------------------------------------------------
// Action type lookups
// ---------------------------------------------------------------------------

interface ActionTypeRow {
  action_type_id: string;
  ontology_id: string;
  api_name: string;
  display_name: string;
  description: string | null;
  parameters: unknown[] | null;
  rules: unknown[] | null;
  submission_criteria: unknown | null;
  is_enabled: boolean;
  max_affected_objects: number;
  created_at: string;
  updated_at: string;
}

function rowToActionType(row: ActionTypeRow): ActionTypeMetadata {
  return {
    id: row.action_type_id,
    ontologyId: row.ontology_id,
    apiName: row.api_name,
    displayName: row.display_name,
    description: row.description ?? "",
    parameters: row.parameters ?? [],
    rules: row.rules ?? [],
    submissionCriteria: row.submission_criteria,
    isEnabled: row.is_enabled,
    maxAffectedObjects: row.max_affected_objects,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listActionTypes(
  ontologyRid: string,
): Promise<ActionTypeMetadata[]> {
  const key = `${ontologyRid}|at|listAll`;
  const cached = cache.get(key);
  if (cached) {
    return await instrumentOms("action_type_list", "hit", async () => cached as ActionTypeMetadata[]);
  }
  return await instrumentOms("action_type_list", "miss", async () => {
  const db = getWorkshopDb();
  const r = await db.query(
    `SELECT action_type_id, ontology_id, api_name, display_name,
            description, parameters, rules, submission_criteria,
            is_enabled, max_affected_objects,
            created_at::text, updated_at::text
       FROM action_type
      WHERE ontology_id = $1::uuid
   ORDER BY api_name`,
    [ridToUuid(ontologyRid)],
  );
  const list = (r.rows as ActionTypeRow[]).map(rowToActionType);
  cache.put(key, list);
  return list;
  });
}

export async function getActionType(
  ontologyRid: string,
  idOrApiName: string,
): Promise<ActionTypeMetadata> {
  const key = `${ontologyRid}|at|id|${idOrApiName}`;
  const cached = cache.get(key);
  if (cached) {
    return await instrumentOms("action_type_get", "hit", async () => cached as ActionTypeMetadata);
  }
  return await instrumentOms("action_type_get", "miss", async () => {
  const db = getWorkshopDb();
  const r = await db.query(
    `SELECT action_type_id, ontology_id, api_name, display_name,
            description, parameters, rules, submission_criteria,
            is_enabled, max_affected_objects,
            created_at::text, updated_at::text
       FROM action_type
      WHERE ontology_id = $1::uuid
        AND (action_type_id::text = $2 OR api_name = $2)
      LIMIT 1`,
    [ridToUuid(ontologyRid), idOrApiName],
  );
  if (r.rows.length === 0) {
    throw actionTypeNotFound(ontologyRid, idOrApiName);
  }
  const meta = rowToActionType(r.rows[0] as ActionTypeRow);
  cache.put(key, meta);
  return meta;
  });
}

// Suppress "unused" for the ontologyNotFound import — surfaced via routes.
void ontologyNotFound;
