// B10.07 — save / get object set as Compass resource.
//
// An object_set is a saved IR query — registered as a resource of type
// OBJECT_SET so it inherits all of Compass's permission and audit
// machinery. We re-use the existing `resources` table; the IR payload
// lives in resources.metadata.objectSet.
import { pool as defaultPool } from "../../db";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { parseSearchRequest } from "./irSchema";

export interface SavedObjectSet {
  rid: string;
  ontologyRid: string;
  objectType: string;
  branchRid: string | null;
  query: unknown;
  displayName: string;
  createdBy: string | null;
}

export class ObjectSetService {
  constructor(private readonly pool: Pool = defaultPool) {}

  async save(opts: {
    actorId: string;
    parentFolderRid: string;
    displayName: string;
    request: unknown;
  }): Promise<SavedObjectSet> {
    // Validate the IR before saving so the persisted record is always
    // re-executable.
    const parsed = parseSearchRequest(opts.request);
    const rid = `ri.compass.main.object-set.${randomUUID()}`;
    const metadata = {
      objectSet: {
        ontologyRid: parsed.ontologyRid,
        objectType: parsed.objectType,
        branchRid: parsed.branchRid ?? null,
        query: parsed,
      },
    };
    // Find space_rid + project_rid by walking up from parent folder.
    const parent = await this.pool.query<{ space_rid: string; project_rid: string | null }>(
      `SELECT space_rid, project_rid FROM resources WHERE rid = $1`,
      [opts.parentFolderRid],
    );
    if (parent.rows.length === 0) throw new Error(`PARENT_NOT_FOUND: ${opts.parentFolderRid}`);
    await this.pool.query(
      `INSERT INTO resources (rid, service, type, display_name, parent_folder_rid, project_rid, space_rid, created_by, updated_by, metadata)
       VALUES ($1,'compass','OBJECT_SET',$2,$3,$4,$5,$6,$6,$7::jsonb)`,
      [rid, opts.displayName, opts.parentFolderRid, parent.rows[0].project_rid, parent.rows[0].space_rid, opts.actorId, JSON.stringify(metadata)],
    );
    return { rid, ontologyRid: parsed.ontologyRid, objectType: parsed.objectType, branchRid: parsed.branchRid ?? null, query: parsed, displayName: opts.displayName, createdBy: opts.actorId };
  }

  async get(rid: string): Promise<SavedObjectSet | null> {
    const { rows } = await this.pool.query(`SELECT rid, display_name, created_by, metadata FROM resources WHERE rid = $1 AND type = 'OBJECT_SET'`, [rid]);
    if (rows.length === 0) return null;
    const meta = (rows[0].metadata as { objectSet?: any })?.objectSet;
    if (!meta) return null;
    return {
      rid: rows[0].rid as string,
      ontologyRid: meta.ontologyRid as string,
      objectType: meta.objectType as string,
      branchRid: meta.branchRid ?? null,
      query: meta.query,
      displayName: rows[0].display_name as string,
      createdBy: (rows[0].created_by as string | null) ?? null,
    };
  }
}
export const objectSetService = new ObjectSetService();
