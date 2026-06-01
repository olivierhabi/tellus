/**
 * B10 — Ontology bindings repository (Knex/PG).
 */
import type { Knex } from "knex";
import type { OntologyBinding } from "./contracts";

const TABLE = "ontology_bindings";

export class OntologyBindingsRepo {
  constructor(private readonly db: Knex) {}

  async create(b: OntologyBinding): Promise<OntologyBinding> {
    await this.db(TABLE).insert({
      rid: b.rid,
      dataset_rid: b.dataset_rid,
      object_type_rid: b.object_type_rid,
      property_mappings: JSON.stringify(b.property_mappings),
      link_types: JSON.stringify(b.link_types),
      status: b.status,
      osdk_version: b.osdk_version,
      version: b.version,
      created_at: this.db.fn.now(),
      updated_at: this.db.fn.now(),
    });
    return b;
  }

  async get(rid: string): Promise<OntologyBinding | null> {
    const row = await this.db(TABLE).where({ rid, deleted_at: null }).first();
    return row ? this.hydrate(row) : null;
  }

  async listByObjectType(objectTypeRid: string): Promise<OntologyBinding[]> {
    const rows = await this.db(TABLE)
      .where({ object_type_rid: objectTypeRid, deleted_at: null });
    return rows.map((r) => this.hydrate(r));
  }

  async listByDataset(datasetRid: string): Promise<OntologyBinding[]> {
    const rows = await this.db(TABLE)
      .where({ dataset_rid: datasetRid, deleted_at: null });
    return rows.map((r) => this.hydrate(r));
  }

  async updateOcc(
    rid: string,
    expectedVersion: number,
    patch: Partial<OntologyBinding>,
  ): Promise<OntologyBinding | null> {
    const sets: Record<string, unknown> = { updated_at: this.db.fn.now() };
    if (patch.property_mappings) sets.property_mappings = JSON.stringify(patch.property_mappings);
    if (patch.link_types) sets.link_types = JSON.stringify(patch.link_types);
    if (patch.status !== undefined) sets.status = patch.status;
    if (patch.osdk_version !== undefined) sets.osdk_version = patch.osdk_version;
    sets.version = this.db.raw("version + 1");
    const [row] = await this.db(TABLE)
      .where({ rid, version: expectedVersion, deleted_at: null })
      .update(sets)
      .returning("*");
    return row ? this.hydrate(row) : null;
  }

  async softDelete(rid: string): Promise<boolean> {
    const n = await this.db(TABLE)
      .where({ rid, deleted_at: null })
      .update({ deleted_at: this.db.fn.now() });
    return n > 0;
  }

  private hydrate(row: any): OntologyBinding {
    return {
      rid: row.rid,
      dataset_rid: row.dataset_rid,
      object_type_rid: row.object_type_rid,
      property_mappings: typeof row.property_mappings === "string"
        ? JSON.parse(row.property_mappings) : row.property_mappings,
      link_types: typeof row.link_types === "string"
        ? JSON.parse(row.link_types) : row.link_types,
      status: row.status,
      osdk_version: row.osdk_version,
      version: row.version,
    };
  }
}
