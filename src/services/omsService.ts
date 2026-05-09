// ---------------------------------------------------------------------------
// omsService — Ontology Management Service (B8.07+).
//
// CRUD for object_types / link_types / shared_property_types / interfaces.
// Foundry-faithful validation per SPEC.md §B8.
// ---------------------------------------------------------------------------
import { pool as defaultPool } from "../db";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { publishEvent } from "./kafkaProducer";

export interface ObjectTypeProperty {
  apiName: string;
  displayName: string;
  dataType: string;
  nullable?: boolean;
  isPrimaryKey?: boolean;
  propertyMapping?: Record<string, unknown>;
}

export interface ObjectTypeDatasource {
  datasourceRid: string;
  primaryKeyColumns: string[];
  propertyMapping?: Record<string, string>;
  isPrimary?: boolean;
}

export interface CreateObjectTypeInput {
  ontologyRid: string;
  branchRid?: string | null;
  apiName: string;
  displayName: string;
  pluralDisplayName?: string;
  titleProperty?: string;
  primaryKeys: string[];
  status?: 'EXPERIMENTAL' | 'ACTIVE' | 'DEPRECATED';
  properties: ObjectTypeProperty[];
  datasources?: ObjectTypeDatasource[];
  actorId?: string;
}

export interface ObjectType {
  rid: string;
  ontologyRid: string;
  branchRid: string | null;
  apiName: string;
  displayName: string;
  status: string;
  etag: number;
  primaryKeys: string[];
}

const API_NAME_REGEX = /^[a-z][a-zA-Z0-9_]*$/;

export class ValidationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    // Prefix the message with the code so `toThrow(/CODE/)` matchers can
    // assert the code without reaching for the .code field.
    super(`${code}: ${message}`);
    this.code = code;
    this.name = 'ValidationError';
  }
}

export class OmsService {
  constructor(private readonly pool: Pool = defaultPool) {}

  validateCreate(input: CreateObjectTypeInput): void {
    if (!input.apiName || !API_NAME_REGEX.test(input.apiName)) {
      throw new ValidationError('INVALID_API_NAME', `apiName '${input.apiName}' does not match ^[a-z][a-zA-Z0-9_]*$`);
    }
    if (!input.displayName) {
      throw new ValidationError('MISSING_DISPLAY_NAME', 'displayName is required');
    }
    if (!Array.isArray(input.primaryKeys) || input.primaryKeys.length === 0) {
      throw new ValidationError('PRIMARY_KEYS_REQUIRED', 'primaryKeys must be a non-empty array');
    }
    if (!Array.isArray(input.properties) || input.properties.length === 0) {
      throw new ValidationError('PROPERTIES_REQUIRED', 'properties must be non-empty');
    }
    const propNames = new Set(input.properties.map((p) => p.apiName));
    for (const pk of input.primaryKeys) {
      if (!propNames.has(pk)) {
        throw new ValidationError('PK_NOT_FOUND', `primary key '${pk}' is not in properties`);
      }
    }
    if (input.titleProperty && !propNames.has(input.titleProperty)) {
      throw new ValidationError('TITLE_PROPERTY_NOT_FOUND', `titleProperty '${input.titleProperty}' is not in properties`);
    }
    for (const ds of input.datasources ?? []) {
      if (ds.primaryKeyColumns.length !== input.primaryKeys.length) {
        throw new ValidationError(
          'PK_LENGTH_MISMATCH',
          `datasource ${ds.datasourceRid} primary_key_columns length (${ds.primaryKeyColumns.length}) ≠ object_type primary_keys length (${input.primaryKeys.length})`,
        );
      }
      const mappingProps = Object.keys(ds.propertyMapping ?? {});
      for (const k of mappingProps) {
        if (!propNames.has(k)) {
          throw new ValidationError(
            'PROPERTY_MAPPING_UNKNOWN',
            `datasource ${ds.datasourceRid} property_mapping references unknown property '${k}'`,
          );
        }
      }
    }
  }

  async createObjectType(input: CreateObjectTypeInput): Promise<ObjectType> {
    this.validateCreate(input);
    const rid = `ri.ontology.main.object-type.${randomUUID()}`;
    const status = input.status ?? 'EXPERIMENTAL';
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO object_types (rid, ontology_rid, branch_rid, api_name, display_name, plural_display_name, title_property, primary_keys, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          rid,
          input.ontologyRid,
          input.branchRid ?? null,
          input.apiName,
          input.displayName,
          input.pluralDisplayName ?? null,
          input.titleProperty ?? null,
          input.primaryKeys,
          status,
          input.actorId ?? null,
        ],
      );
      for (const p of input.properties) {
        await client.query(
          `INSERT INTO object_type_properties (object_type_rid, api_name, display_name, data_type, nullable, is_primary_key, property_mapping)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            rid,
            p.apiName,
            p.displayName,
            p.dataType,
            p.nullable ?? true,
            p.isPrimaryKey ?? false,
            JSON.stringify(p.propertyMapping ?? {}),
          ],
        );
      }
      for (const ds of input.datasources ?? []) {
        await client.query(
          `INSERT INTO object_type_datasources (object_type_rid, datasource_rid, primary_key_columns, property_mapping, is_primary)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            rid,
            ds.datasourceRid,
            ds.primaryKeyColumns,
            JSON.stringify(ds.propertyMapping ?? {}),
            ds.isPrimary ?? false,
          ],
        );
        // B8.10 — register BACKS / INPUT_OF edges in resource_dependencies
        // BACKS:    object_type → datasource (object_type "is backed by" the datasource)
        // INPUT_OF: datasource → object_type (datasource "is input to" the object_type)
        await client.query(
          `INSERT INTO resource_dependencies (upstream_rid, downstream_rid, edge_type, created_by)
           VALUES ($1, $2, 'BACKS', $3) ON CONFLICT DO NOTHING`,
          [rid, ds.datasourceRid, input.actorId ?? null],
        );
        await client.query(
          `INSERT INTO resource_dependencies (upstream_rid, downstream_rid, edge_type, created_by)
           VALUES ($1, $2, 'INPUT_OF', $3) ON CONFLICT DO NOTHING`,
          [ds.datasourceRid, rid, input.actorId ?? null],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    return {
      rid,
      ontologyRid: input.ontologyRid,
      branchRid: input.branchRid ?? null,
      apiName: input.apiName,
      displayName: input.displayName,
      status,
      etag: 1,
      primaryKeys: input.primaryKeys,
    };
  }

  async getObjectType(
    ontologyRid: string,
    apiName: string,
    branchRid: string | null = null,
  ): Promise<ObjectType | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM object_types
       WHERE ontology_rid = $1 AND api_name = $2
         AND COALESCE(branch_rid, '__main__') = COALESCE($3, '__main__')`,
      [ontologyRid, apiName, branchRid],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      rid: r.rid,
      ontologyRid: r.ontology_rid,
      branchRid: r.branch_rid ?? null,
      apiName: r.api_name,
      displayName: r.display_name,
      status: r.status,
      etag: Number(r.etag),
      primaryKeys: r.primary_keys ?? [],
    };
  }

  async listObjectTypes(
    ontologyRid: string,
    branchRid: string | null = null,
  ): Promise<ObjectType[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM object_types
       WHERE ontology_rid = $1
         AND COALESCE(branch_rid, '__main__') = COALESCE($2, '__main__')
       ORDER BY api_name`,
      [ontologyRid, branchRid],
    );
    return rows.map((r) => ({
      rid: r.rid,
      ontologyRid: r.ontology_rid,
      branchRid: r.branch_rid ?? null,
      apiName: r.api_name,
      displayName: r.display_name,
      status: r.status,
      etag: Number(r.etag),
      primaryKeys: r.primary_keys ?? [],
    }));
  }

  /**
   * Update an object_type with If-Match semantics. Throws on:
   *   NOT_FOUND          — rid does not exist
   *   PRECONDITION_FAILED — expectedEtag doesn't match current etag
   *   IMMUTABLE_API_NAME — apiName change attempted after status=ACTIVE
   *   INVALID_API_NAME   — new apiName violates regex
   */
  async updateObjectType(
    rid: string,
    expectedEtag: number,
    patch: { apiName?: string; displayName?: string; pluralDisplayName?: string; titleProperty?: string; status?: 'EXPERIMENTAL' | 'ACTIVE' | 'DEPRECATED' },
  ): Promise<ObjectType> {
    const { rows } = await this.pool.query(
      `SELECT * FROM object_types WHERE rid = $1`,
      [rid],
    );
    if (rows.length === 0) throw new ValidationError('NOT_FOUND', `object_type ${rid} not found`);
    const current = rows[0];
    if (Number(current.etag) !== expectedEtag) {
      throw new ValidationError('PRECONDITION_FAILED', `expected etag ${expectedEtag}, current=${current.etag}`);
    }
    if (patch.apiName && patch.apiName !== current.api_name) {
      if (current.status === 'ACTIVE') {
        throw new ValidationError('IMMUTABLE_API_NAME', `apiName cannot be changed once status is ACTIVE (current=${current.api_name})`);
      }
      if (!API_NAME_REGEX.test(patch.apiName)) {
        throw new ValidationError('INVALID_API_NAME', `apiName '${patch.apiName}' violates regex`);
      }
    }
    const r = await this.pool.query(
      `UPDATE object_types SET
         api_name           = COALESCE($2, api_name),
         display_name       = COALESCE($3, display_name),
         plural_display_name = COALESCE($4, plural_display_name),
         title_property     = COALESCE($5, title_property),
         status             = COALESCE($6, status),
         etag               = etag + 1,
         updated_at         = now()
       WHERE rid = $1
       RETURNING *`,
      [
        rid,
        patch.apiName ?? null,
        patch.displayName ?? null,
        patch.pluralDisplayName ?? null,
        patch.titleProperty ?? null,
        patch.status ?? null,
      ],
    );
    const u = r.rows[0];
    // B8.11 — emit `tellus.oms.object-type.updated` so downstream
    // consumers can react. Best-effort: publishEvent swallows broker
    // outages internally.
    try {
      await publishEvent('ontology.events', {
        objectType: 'tellus.oms.object-type.updated',
        objectTypeRid: u.rid,
        ontologyRid: u.ontology_rid,
        branchRid: u.branch_rid ?? null,
        etag: Number(u.etag),
        updatedAt: u.updated_at,
      });
    } catch {
      /* best-effort */
    }
    return {
      rid: u.rid,
      ontologyRid: u.ontology_rid,
      branchRid: u.branch_rid ?? null,
      apiName: u.api_name,
      displayName: u.display_name,
      status: u.status,
      etag: Number(u.etag),
      primaryKeys: u.primary_keys ?? [],
    };
  }
}

// ---------------------------------------------------------------------------
// B8.12 — link_types (extension methods on OmsService).
// ---------------------------------------------------------------------------

export interface CreateLinkTypeInput {
  ontologyRid: string;
  branchRid?: string | null;
  apiName: string;
  displayName: string;
  backingType: 'FOREIGN_KEY' | 'JOIN_TABLE' | 'OBJECT_BACKED';
  cardinality: 'ONE_TO_ONE' | 'ONE_TO_MANY' | 'MANY_TO_ONE' | 'MANY_TO_MANY';
  aObjectTypeRid: string;
  bObjectTypeRid: string;
  status?: 'EXPERIMENTAL' | 'ACTIVE' | 'DEPRECATED';
  actorId?: string;
}

export interface LinkType {
  rid: string;
  ontologyRid: string;
  branchRid: string | null;
  apiName: string;
  displayName: string;
  backingType: string;
  cardinality: string;
  aObjectTypeRid: string;
  bObjectTypeRid: string;
  status: string;
  etag: number;
}

export interface OmsService {
  createLinkType(input: CreateLinkTypeInput): Promise<LinkType>;
  getLinkType(ontologyRid: string, apiName: string, branchRid?: string | null): Promise<LinkType | null>;
  listLinkTypes(ontologyRid: string, branchRid?: string | null): Promise<LinkType[]>;
}

OmsService.prototype.createLinkType = async function createLinkType(this: OmsService, input: CreateLinkTypeInput): Promise<LinkType> {
  if (!input.apiName || !API_NAME_REGEX.test(input.apiName)) {
    throw new ValidationError('INVALID_API_NAME', `apiName '${input.apiName}' does not match ^[a-z][a-zA-Z0-9_]*$`);
  }
  if (!input.displayName) {
    throw new ValidationError('MISSING_DISPLAY_NAME', 'displayName is required');
  }
  if (input.aObjectTypeRid === input.bObjectTypeRid && input.cardinality !== 'MANY_TO_MANY' && input.cardinality !== 'ONE_TO_MANY') {
    // self-link is allowed only for self-referential MANY_TO_MANY / ONE_TO_MANY (e.g. tree).
    throw new ValidationError('INVALID_SELF_LINK', `self-link requires MANY_TO_MANY or ONE_TO_MANY cardinality`);
  }
  const validBacking = ['FOREIGN_KEY','JOIN_TABLE','OBJECT_BACKED'];
  const validCardinality = ['ONE_TO_ONE','ONE_TO_MANY','MANY_TO_ONE','MANY_TO_MANY'];
  if (!validBacking.includes(input.backingType)) {
    throw new ValidationError('INVALID_BACKING_TYPE', `backingType '${input.backingType}' not in ${validBacking.join(',')}`);
  }
  if (!validCardinality.includes(input.cardinality)) {
    throw new ValidationError('INVALID_CARDINALITY', `cardinality '${input.cardinality}' not in ${validCardinality.join(',')}`);
  }
  const rid = `ri.ontology.main.link-type.${randomUUID()}`;
  const status = input.status ?? 'EXPERIMENTAL';
  const pool = (this as unknown as { pool: Pool }).pool;
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM object_types WHERE rid = ANY($1::text[])`,
    [[input.aObjectTypeRid, input.bObjectTypeRid]],
  );
  if (existing.length < 2) {
    throw new ValidationError('OBJECT_TYPE_NOT_FOUND', `one or both endpoint object_types do not exist`);
  }
  const r = await pool.query(
    `INSERT INTO link_types (rid, ontology_rid, branch_rid, api_name, display_name, backing_type, cardinality, a_object_type_rid, b_object_type_rid, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [rid, input.ontologyRid, input.branchRid ?? null, input.apiName, input.displayName, input.backingType, input.cardinality, input.aObjectTypeRid, input.bObjectTypeRid, status, input.actorId ?? null],
  );
  const u = r.rows[0];
  return fromLinkRow(u);
};

OmsService.prototype.getLinkType = async function getLinkType(this: OmsService, ontologyRid: string, apiName: string, branchRid: string | null = null): Promise<LinkType | null> {
  const pool = (this as unknown as { pool: Pool }).pool;
  const { rows } = await pool.query(
    `SELECT * FROM link_types
     WHERE ontology_rid = $1 AND api_name = $2
       AND COALESCE(branch_rid, '__main__') = COALESCE($3, '__main__')`,
    [ontologyRid, apiName, branchRid],
  );
  return rows[0] ? fromLinkRow(rows[0]) : null;
};

OmsService.prototype.listLinkTypes = async function listLinkTypes(this: OmsService, ontologyRid: string, branchRid: string | null = null): Promise<LinkType[]> {
  const pool = (this as unknown as { pool: Pool }).pool;
  const { rows } = await pool.query(
    `SELECT * FROM link_types
     WHERE ontology_rid = $1
       AND COALESCE(branch_rid, '__main__') = COALESCE($2, '__main__')
     ORDER BY api_name`,
    [ontologyRid, branchRid],
  );
  return rows.map(fromLinkRow);
};

function fromLinkRow(r: Record<string, unknown>): LinkType {
  return {
    rid: r.rid as string,
    ontologyRid: r.ontology_rid as string,
    branchRid: (r.branch_rid as string | null) ?? null,
    apiName: r.api_name as string,
    displayName: r.display_name as string,
    backingType: r.backing_type as string,
    cardinality: r.cardinality as string,
    aObjectTypeRid: r.a_object_type_rid as string,
    bObjectTypeRid: r.b_object_type_rid as string,
    status: r.status as string,
    etag: Number(r.etag),
  };
}

// ---------------------------------------------------------------------------
// B8.13 — sharedPropertyTypes + interfaces (extension methods on OmsService).
// ---------------------------------------------------------------------------

export interface CreateSharedPropertyTypeInput {
  ontologyRid: string;
  apiName: string;
  displayName: string;
  dataType: string;
}
export interface SharedPropertyType {
  rid: string;
  ontologyRid: string;
  apiName: string;
  displayName: string;
  dataType: string;
}

export interface CreateInterfaceInput {
  ontologyRid: string;
  apiName: string;
  displayName: string;
  properties: string[];
}
export interface Interface {
  rid: string;
  ontologyRid: string;
  apiName: string;
  displayName: string;
  properties: string[];
}

export interface OmsService {
  createSharedPropertyType(input: CreateSharedPropertyTypeInput): Promise<SharedPropertyType>;
  getSharedPropertyType(ontologyRid: string, apiName: string): Promise<SharedPropertyType | null>;
  listSharedPropertyTypes(ontologyRid: string): Promise<SharedPropertyType[]>;
  createInterface(input: CreateInterfaceInput): Promise<Interface>;
  getInterface(ontologyRid: string, apiName: string): Promise<Interface | null>;
  listInterfaces(ontologyRid: string): Promise<Interface[]>;
}

OmsService.prototype.createSharedPropertyType = async function (this: OmsService, input: CreateSharedPropertyTypeInput): Promise<SharedPropertyType> {
  if (!input.apiName || !API_NAME_REGEX.test(input.apiName)) {
    throw new ValidationError('INVALID_API_NAME', `apiName '${input.apiName}' violates regex`);
  }
  if (!input.displayName) throw new ValidationError('MISSING_DISPLAY_NAME', 'displayName required');
  if (!input.dataType) throw new ValidationError('MISSING_DATA_TYPE', 'dataType required');
  const rid = `ri.ontology.main.spt.${randomUUID()}`;
  const pool = (this as unknown as { pool: Pool }).pool;
  const r = await pool.query(
    `INSERT INTO shared_property_types (rid, ontology_rid, api_name, display_name, data_type)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [rid, input.ontologyRid, input.apiName, input.displayName, input.dataType],
  );
  const u = r.rows[0];
  return { rid: u.rid, ontologyRid: u.ontology_rid, apiName: u.api_name, displayName: u.display_name, dataType: u.data_type };
};

OmsService.prototype.getSharedPropertyType = async function (this: OmsService, ontologyRid: string, apiName: string): Promise<SharedPropertyType | null> {
  const pool = (this as unknown as { pool: Pool }).pool;
  const { rows } = await pool.query(
    `SELECT * FROM shared_property_types WHERE ontology_rid = $1 AND api_name = $2`,
    [ontologyRid, apiName],
  );
  if (rows.length === 0) return null;
  const u = rows[0];
  return { rid: u.rid, ontologyRid: u.ontology_rid, apiName: u.api_name, displayName: u.display_name, dataType: u.data_type };
};

OmsService.prototype.listSharedPropertyTypes = async function (this: OmsService, ontologyRid: string): Promise<SharedPropertyType[]> {
  const pool = (this as unknown as { pool: Pool }).pool;
  const { rows } = await pool.query(
    `SELECT * FROM shared_property_types WHERE ontology_rid = $1 ORDER BY api_name`,
    [ontologyRid],
  );
  return rows.map((u: Record<string, unknown>) => ({
    rid: u.rid as string,
    ontologyRid: u.ontology_rid as string,
    apiName: u.api_name as string,
    displayName: u.display_name as string,
    dataType: u.data_type as string,
  }));
};

OmsService.prototype.createInterface = async function (this: OmsService, input: CreateInterfaceInput): Promise<Interface> {
  if (!input.apiName || !API_NAME_REGEX.test(input.apiName)) {
    throw new ValidationError('INVALID_API_NAME', `apiName '${input.apiName}' violates regex`);
  }
  if (!input.displayName) throw new ValidationError('MISSING_DISPLAY_NAME', 'displayName required');
  if (!Array.isArray(input.properties)) throw new ValidationError('PROPERTIES_REQUIRED', 'properties must be an array');
  const rid = `ri.ontology.main.iface.${randomUUID()}`;
  const pool = (this as unknown as { pool: Pool }).pool;
  const r = await pool.query(
    `INSERT INTO interfaces (rid, ontology_rid, api_name, display_name, properties)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [rid, input.ontologyRid, input.apiName, input.displayName, input.properties],
  );
  const u = r.rows[0];
  return { rid: u.rid, ontologyRid: u.ontology_rid, apiName: u.api_name, displayName: u.display_name, properties: u.properties ?? [] };
};

OmsService.prototype.getInterface = async function (this: OmsService, ontologyRid: string, apiName: string): Promise<Interface | null> {
  const pool = (this as unknown as { pool: Pool }).pool;
  const { rows } = await pool.query(
    `SELECT * FROM interfaces WHERE ontology_rid = $1 AND api_name = $2`,
    [ontologyRid, apiName],
  );
  if (rows.length === 0) return null;
  const u = rows[0];
  return { rid: u.rid, ontologyRid: u.ontology_rid, apiName: u.api_name, displayName: u.display_name, properties: u.properties ?? [] };
};

OmsService.prototype.listInterfaces = async function (this: OmsService, ontologyRid: string): Promise<Interface[]> {
  const pool = (this as unknown as { pool: Pool }).pool;
  const { rows } = await pool.query(
    `SELECT * FROM interfaces WHERE ontology_rid = $1 ORDER BY api_name`,
    [ontologyRid],
  );
  return rows.map((u: Record<string, unknown>) => ({
    rid: u.rid as string,
    ontologyRid: u.ontology_rid as string,
    apiName: u.api_name as string,
    displayName: u.display_name as string,
    properties: (u.properties as string[]) ?? [],
  }));
};

export const omsService = new OmsService();
