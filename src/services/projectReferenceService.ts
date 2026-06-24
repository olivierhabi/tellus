// projectReferenceService — manage project_references rows (B6.05).
import { pool as defaultPool } from "../db";
import type { Pool } from "pg";

export class ProjectReferenceService {
  constructor(private readonly pool: Pool = defaultPool) {}
  async addReference(ownerProjectRid: string, referencedRid: string, referenceType = "IMPORT", actorId?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_references (owner_project_rid, referenced_resource_rid, reference_type, created_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [ownerProjectRid, referencedRid, referenceType, actorId ?? null],
    );
  }
  async removeReference(ownerProjectRid: string, referencedRid: string, referenceType = "IMPORT"): Promise<{ removed: number }> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM project_references WHERE owner_project_rid=$1 AND referenced_resource_rid=$2 AND reference_type=$3`,
      [ownerProjectRid, referencedRid, referenceType],
    );
    return { removed: rowCount ?? 0 };
  }
  async listReferences(ownerProjectRid: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ referenced_resource_rid: string }>(
      `SELECT referenced_resource_rid FROM project_references WHERE owner_project_rid = $1 ORDER BY created_at DESC`,
      [ownerProjectRid],
    );
    return rows.map((r) => r.referenced_resource_rid);
  }
  async listProjectsReferencing(referencedRid: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ owner_project_rid: string }>(
      `SELECT DISTINCT owner_project_rid FROM project_references WHERE referenced_resource_rid = $1`,
      [referencedRid],
    );
    return rows.map((r) => r.owner_project_rid);
  }
}
export const projectReferenceService = new ProjectReferenceService();
