// ---------------------------------------------------------------------------
// ObjectSet store — saved (versioned) + temporary object sets (Phase 5)
//
// Upgrades the existing persistence instead of creating a parallel
// service:
//   * Saved/versioned sets live in the Compass `resources` table
//     (existing OBJECT_SET resource type, see oss/objectSetService.ts).
//   * Temporary sets live in the shared overlay store (Redis in prod,
//     in-memory in dev/test) with TTL + tenant/ontology scoping.
//
// RID namespaces:
//   * Saved:     ri.object-set.main.versioned-object-set.<uuid>   (verified)
//   * Temporary: ri.object-set.main.temporary-object-set.<uuid>   (Tellus
//                choice — the public spec does not document the
//                temporary RID format)
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { pool as defaultPool } from "../../db";
import type { Pool } from "pg";
import { getOverlayStore } from "../overlay/getOverlayStore";
import type { OverlayRecord, OverlayStore } from "../overlay/overlayStore";
import type { ObjectSet } from "./objectSetDefinition";
import {
  MAX_TEMP_OBJECT_SET_BYTES,
  stableStringify,
  parseObjectSet,
} from "./objectSetDefinition";

export const SAVED_OBJECT_SET_RID_PREFIX =
  "ri.object-set.main.versioned-object-set.";
export const TEMP_OBJECT_SET_RID_PREFIX =
  "ri.object-set.main.temporary-object-set.";

export const TEMP_OBJECT_SET_TTL_SECONDS = Number(
  process.env.TELLUS_TEMP_OBJECT_SET_TTL_SECONDS ?? 3600,
);

export function isSavedObjectSetRid(rid: string): boolean {
  return rid.startsWith(SAVED_OBJECT_SET_RID_PREFIX);
}
export function isTempObjectSetRid(rid: string): boolean {
  return rid.startsWith(TEMP_OBJECT_SET_RID_PREFIX);
}
export function mintSavedObjectSetRid(): string {
  return `${SAVED_OBJECT_SET_RID_PREFIX}${randomUUID()}`;
}

export class ObjectSetStoreError extends Error {
  constructor(
    public readonly errorName: string,
    message: string,
    public readonly parameters: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ObjectSetStoreError";
  }
}

// ---------------------------------------------------------------------------
// Saved (versioned) sets — resources table
// ---------------------------------------------------------------------------

export class SavedObjectSetStore {
  constructor(private readonly pool: Pool = defaultPool) {}

  /** Persist an ObjectSet definition as a versioned Compass resource. */
  async save(opts: {
    actorId: string;
    parentFolderRid: string;
    displayName: string;
    objectSet: ObjectSet;
  }): Promise<{ rid: string }> {
    // Re-validate so the persisted record is always re-executable.
    const parsed = parseObjectSet(opts.objectSet);
    const rid = mintSavedObjectSetRid();
    const parent = await this.pool.query<{
      space_rid: string;
      project_rid: string | null;
    }>(`SELECT space_rid, project_rid FROM resources WHERE rid = $1`, [
      opts.parentFolderRid,
    ]);
    if (parent.rows.length === 0) {
      throw new ObjectSetStoreError("FolderNotFound", `Parent folder not found: ${opts.parentFolderRid}`);
    }
    await this.pool.query(
      `INSERT INTO resources (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid, created_by, updated_by, metadata)
       VALUES ($1,'compass','OBJECT_SET',$2,$3,$4,$5,$6,$6,$7::jsonb)`,
      [
        rid,
        opts.displayName,
        opts.parentFolderRid,
        parent.rows[0].project_rid,
        parent.rows[0].space_rid,
        opts.actorId,
        JSON.stringify({ objectSet: { definition: parsed } }),
      ],
    );
    return { rid };
  }

  async get(rid: string): Promise<ObjectSet | null> {
    const { rows } = await this.pool.query(
      `SELECT metadata FROM resources WHERE rid = $1 AND type = 'OBJECT_SET'`,
      [rid],
    );
    if (rows.length === 0) return null;
    const def = (rows[0].metadata as { objectSet?: { definition?: unknown } })
      ?.objectSet?.definition;
    if (!def) return null;
    try {
      return parseObjectSet(def);
    } catch {
      throw new ObjectSetStoreError(
        "StoredObjectSetInvalid",
        `Stored object set ${rid} failed validation and cannot be executed.`,
        { reference: rid },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Temporary sets — shared overlay store (Redis / memory), TTL-bound
// ---------------------------------------------------------------------------

interface TempPayload {
  objectSet: ObjectSet;
  ontologyRid: string;
  tenant: string;
  branchRid: string | null;
  createdBy: string;
  createdAt: number;
}

export class TemporaryObjectSetStore {
  constructor(private readonly store?: OverlayStore) {}

  private async backend(): Promise<OverlayStore> {
    return this.store ?? (await getOverlayStore());
  }

  async create(opts: {
    objectSet: ObjectSet;
    ontologyRid: string;
    tenant: string;
    branchRid: string | null;
    createdBy: string;
  }): Promise<{ objectSetRid: string }> {
    // Deterministic serialization + bounded payload.
    const parsed = parseObjectSet(opts.objectSet);
    const serialized = stableStringify(parsed);
    if (Buffer.byteLength(serialized, "utf8") > MAX_TEMP_OBJECT_SET_BYTES) {
      throw new ObjectSetStoreError(
        "ObjectSetTooLarge",
        `Temporary object set exceeds ${MAX_TEMP_OBJECT_SET_BYTES} bytes.`,
      );
    }
    const uuid = randomUUID();
    const rid = `${TEMP_OBJECT_SET_RID_PREFIX}${uuid}`;
    const payload: TempPayload = {
      objectSet: parsed,
      ontologyRid: opts.ontologyRid,
      tenant: opts.tenant,
      branchRid: opts.branchRid,
      createdBy: opts.createdBy,
      createdAt: Date.now(),
    };
    const record: OverlayRecord = {
      branchId: "_main",
      objectType: "__objectSet__",
      primaryKey: uuid,
      doc: payload as unknown as Record<string, unknown>,
      deleted: false,
      version: 1,
      createdAt: Date.now(),
      editId: uuid,
    };
    try {
      const store = await this.backend();
      await store.put(
        this.key(opts.tenant, uuid),
        record,
        TEMP_OBJECT_SET_TTL_SECONDS,
      );
    } catch {
      throw new ObjectSetStoreError(
        "TemporaryObjectSetStoreUnavailable",
        "Temporary ObjectSet storage is temporarily unavailable.",
        { retryable: true },
      );
    }
    return { objectSetRid: rid };
  }

  async resolve(
    rid: string,
    ctx: {
      tenant: string;
      ontologyRid: string;
      branchRid: string | null;
      userId?: string;
    },
  ): Promise<ObjectSet | null> {
    if (!isTempObjectSetRid(rid)) return null;
    const uuid = rid.slice(TEMP_OBJECT_SET_RID_PREFIX.length);
    let mget: Array<OverlayRecord | null>;
    try {
      const store = await this.backend();
      // Tenant isolation: a temporary rid must NEVER resolve across
      // tenants — the key itself is tenant-scoped.
      mget = await store.mget([this.key(ctx.tenant, uuid)]);
    } catch {
      throw new ObjectSetStoreError(
        "TemporaryObjectSetStoreUnavailable",
        "Temporary ObjectSet storage is temporarily unavailable.",
        { retryable: true },
      );
    }
    const rec = mget[0];
    if (!rec || rec.deleted) return null;
    const payload = rec.doc as unknown as TempPayload;
    // Ontology isolation: rid minted under one ontology does not
    // resolve under another.
    if (payload.ontologyRid !== ctx.ontologyRid) return null;
    // Branch isolation: a temporary set captures the branch in which it
    // was created and cannot be replayed against another branch.
    if ((payload.branchRid ?? null) !== (ctx.branchRid ?? null)) return null;
    if (ctx.userId && payload.createdBy !== ctx.userId) return null;
    return payload.objectSet;
  }

  private key(tenant: string, uuid: string): string {
    return `tmp-object-set:${tenant}:${uuid}`;
  }
}

// ---------------------------------------------------------------------------
// Unified reference resolver (compiler dependency)
// ---------------------------------------------------------------------------

export function createReferenceResolver(deps: {
  saved?: SavedObjectSetStore;
  temp?: TemporaryObjectSetStore;
  tenant: string;
  ontologyRid: string;
  branchRid: string | null;
  userId?: string;
}): (rid: string) => Promise<ObjectSet | null> {
  const saved = deps.saved ?? new SavedObjectSetStore();
  const temp = deps.temp ?? new TemporaryObjectSetStore();
  return async (rid: string) => {
    if (isTempObjectSetRid(rid)) {
      return temp.resolve(rid, {
        tenant: deps.tenant,
        ontologyRid: deps.ontologyRid,
        branchRid: deps.branchRid,
        userId: deps.userId,
      });
    }
    if (isSavedObjectSetRid(rid)) {
      return saved.get(rid);
    }
    return null;
  };
}

export const savedObjectSetStore = new SavedObjectSetStore();
export const temporaryObjectSetStore = new TemporaryObjectSetStore();
