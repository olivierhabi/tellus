/**
 * B9 — Funnel binding repository.
 * Persists ObjectTypeBindings; OCC via `version` column.
 *
 * Uses the shared pg Pool (raw parameterized SQL), consistent with the rest
 * of the Tellus service tier (see src/db.ts). No query-builder dependency.
 */
import type { Pool } from "pg";
import type { ObjectTypeBinding } from "../contracts/object-type-binding";

interface BindingRow {
  rid: string;
  dataset_rid: string;
  object_type_rid: string;
  property_map: unknown;
  indexed_properties: unknown;
  pk_column: string;
  title_property: string | null;
  shard_count: number | string;
  mode: string;
  cdc_topic_short: string | null;
  status: string;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

export class FunnelBindingsRepo {
  constructor(private readonly db: Pool) {}

  async create(b: ObjectTypeBinding): Promise<ObjectTypeBinding> {
    const r = await this.db.query<BindingRow>(
      `INSERT INTO funnel_bindings (
         rid, dataset_rid, object_type_rid, property_map, indexed_properties,
         pk_column, title_property, shard_count, mode, cdc_topic_short,
         status, version
       ) VALUES (
         $1, $2, $3, $4::jsonb, $5::jsonb,
         $6, $7, $8, $9, $10,
         'pending', 1
       )
       RETURNING *`,
      [
        b.rid,
        b.datasetRid,
        b.objectTypeRid,
        JSON.stringify(b.propertyMap),
        JSON.stringify(b.indexedProperties),
        b.pkColumn,
        b.titleProperty ?? null,
        b.shardCount ?? 16,
        b.mode,
        b.cdcTopicShort ?? null,
      ],
    );
    return rowToBinding(r.rows[0]);
  }

  async get(rid: string): Promise<ObjectTypeBinding | null> {
    const r = await this.db.query<BindingRow>(
      `SELECT * FROM funnel_bindings WHERE rid = $1 AND deleted_at IS NULL`,
      [rid],
    );
    return r.rows[0] ? rowToBinding(r.rows[0]) : null;
  }

  async updateStatus(rid: string, status: ObjectTypeBinding["status"]): Promise<void> {
    await this.db.query(
      `UPDATE funnel_bindings SET status = $2, updated_at = now() WHERE rid = $1`,
      [rid, status],
    );
  }

  async listByObjectType(objectTypeRid: string): Promise<ObjectTypeBinding[]> {
    const r = await this.db.query<BindingRow>(
      `SELECT * FROM funnel_bindings
        WHERE object_type_rid = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [objectTypeRid],
    );
    return r.rows.map(rowToBinding);
  }

  /** List bindings, optionally filtered by objectTypeRid. */
  async list(filter: { objectTypeRid?: string } = {}): Promise<ObjectTypeBinding[]> {
    if (filter.objectTypeRid) return this.listByObjectType(filter.objectTypeRid);
    const r = await this.db.query<BindingRow>(
      `SELECT * FROM funnel_bindings WHERE deleted_at IS NULL ORDER BY created_at DESC`,
    );
    return r.rows.map(rowToBinding);
  }

  /**
   * Flip a binding into 'reindexing' status and bump its version.
   * Returns the updated binding, or null if not found.
   */
  async markReindexing(rid: string): Promise<ObjectTypeBinding | null> {
    const r = await this.db.query<BindingRow>(
      `UPDATE funnel_bindings
          SET status = 'reindexing', version = version + 1, updated_at = now()
        WHERE rid = $1 AND deleted_at IS NULL
        RETURNING *`,
      [rid],
    );
    return r.rows[0] ? rowToBinding(r.rows[0]) : null;
  }

  /**
   * Soft-delete with optional optimistic-concurrency check.
   * If ifMatch is omitted, no version filter is applied.
   */
  async softDelete(rid: string, ifMatch?: number): Promise<boolean> {
    const params: unknown[] = [rid];
    let versionClause = "";
    if (ifMatch !== undefined) {
      params.push(ifMatch);
      versionClause = ` AND version = $${params.length}`;
    }
    const r = await this.db.query(
      `UPDATE funnel_bindings
          SET deleted_at = now(), version = version + 1
        WHERE rid = $1 AND deleted_at IS NULL${versionClause}`,
      params,
    );
    return (r.rowCount ?? 0) > 0;
  }
}

function rowToBinding(row: BindingRow): ObjectTypeBinding {
  const propertyMap =
    typeof row.property_map === "string"
      ? JSON.parse(row.property_map)
      : (row.property_map as Record<string, string>);
  const indexedProperties =
    typeof row.indexed_properties === "string"
      ? JSON.parse(row.indexed_properties)
      : (row.indexed_properties as string[]);
  return {
    rid: row.rid as ObjectTypeBinding["rid"],
    datasetRid: row.dataset_rid as ObjectTypeBinding["datasetRid"],
    objectTypeRid: row.object_type_rid as ObjectTypeBinding["objectTypeRid"],
    propertyMap,
    indexedProperties,
    pkColumn: row.pk_column,
    titleProperty: row.title_property ?? undefined,
    shardCount: Number(row.shard_count ?? 16),
    mode: row.mode as ObjectTypeBinding["mode"],
    cdcTopicShort: row.cdc_topic_short ?? undefined,
    status: row.status as ObjectTypeBinding["status"],
    version: Number(row.version ?? 1),
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : (row.created_at as string) ?? new Date().toISOString(),
    updatedAt:
      row.updated_at instanceof Date
        ? row.updated_at.toISOString()
        : (row.updated_at as string) ?? new Date().toISOString(),
  };
}
