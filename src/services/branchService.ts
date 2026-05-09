// branchService — branches CRUD (B7.04+).
import { pool as defaultPool } from "../db";
import type { Pool } from "pg";

export interface Branch {
  id: string;
  projectRid: string;
  name: string;
  parentBranchId: string | null;
  status: 'OPEN' | 'MERGED' | 'CLOSED' | 'ABANDONED';
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  mergedAt: Date | null;
}

function fromRow(r: Record<string, unknown>): Branch {
  return {
    id: r.id as string,
    projectRid: r.project_rid as string,
    name: r.name as string,
    parentBranchId: (r.parent_branch_id as string | null) ?? null,
    status: r.status as Branch['status'],
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
    mergedAt: r.merged_at ? new Date(r.merged_at as string) : null,
  };
}

export class BranchService {
  constructor(private readonly pool: Pool = defaultPool) {}

  async create(projectRid: string, name: string, opts: { actorId?: string; parentBranchId?: string } = {}): Promise<Branch> {
    const { rows } = await this.pool.query(
      `INSERT INTO branches (project_rid, name, parent_branch_id, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [projectRid, name, opts.parentBranchId ?? null, opts.actorId ?? null],
    );
    return fromRow(rows[0]);
  }

  async getById(id: string): Promise<Branch | null> {
    const { rows } = await this.pool.query(`SELECT * FROM branches WHERE id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listByProject(projectRid: string): Promise<Branch[]> {
    const { rows } = await this.pool.query(`SELECT * FROM branches WHERE project_rid = $1 ORDER BY created_at DESC`, [projectRid]);
    return rows.map(fromRow);
  }

  async getByName(projectRid: string, name: string): Promise<Branch | null> {
    const { rows } = await this.pool.query(`SELECT * FROM branches WHERE project_rid = $1 AND name = $2`, [projectRid, name]);
    return rows[0] ? fromRow(rows[0]) : null;
  }
}

export const branchService = new BranchService();
