// ---------------------------------------------------------------------------
// resourceGraphService — DAG of resource_dependencies (B6.03+).
// addEdge: insert (upstream, downstream, type) — fails on cycle.
// removeEdge: delete by triple.
// getUpstream/getDownstream/getLineage: recursive CTE walks.
// ---------------------------------------------------------------------------
import { pool as defaultPool } from "../db";
import type { Pool } from "pg";

export class ResourceGraphService {
  constructor(private readonly pool: Pool = defaultPool) {}

  async addEdge(upstream: string, downstream: string, edgeType = "DEPENDS_ON", actorId?: string): Promise<void> {
    if (upstream === downstream) throw new Error("CYCLE: self-edge");
    // Cycle check: would adding (u→d) create d→...→u path?
    const { rows } = await this.pool.query<{ exists: boolean }>(
      `WITH RECURSIVE downstream_walk AS (
         SELECT downstream_rid AS rid FROM resource_dependencies WHERE upstream_rid = $1
         UNION
         SELECT rd.downstream_rid FROM resource_dependencies rd
         JOIN downstream_walk dw ON rd.upstream_rid = dw.rid
       )
       SELECT EXISTS(SELECT 1 FROM downstream_walk WHERE rid = $2) AS exists`,
      [downstream, upstream],
    );
    if (rows[0]?.exists) throw new Error("CYCLE: edge would create a cycle");
    await this.pool.query(
      `INSERT INTO resource_dependencies (upstream_rid, downstream_rid, edge_type, created_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [upstream, downstream, edgeType, actorId ?? null],
    );
  }

  async removeEdge(upstream: string, downstream: string, edgeType = "DEPENDS_ON"): Promise<{ removed: number }> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM resource_dependencies WHERE upstream_rid=$1 AND downstream_rid=$2 AND edge_type=$3`,
      [upstream, downstream, edgeType],
    );
    return { removed: rowCount ?? 0 };
  }

  async getUpstream(rid: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ rid: string }>(
      `WITH RECURSIVE up AS (
         SELECT upstream_rid AS rid FROM resource_dependencies WHERE downstream_rid = $1
         UNION
         SELECT rd.upstream_rid FROM resource_dependencies rd JOIN up ON rd.downstream_rid = up.rid
       ) SELECT rid FROM up`, [rid]);
    return rows.map((r) => r.rid);
  }

  async getDownstream(rid: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ rid: string }>(
      `WITH RECURSIVE down AS (
         SELECT downstream_rid AS rid FROM resource_dependencies WHERE upstream_rid = $1
         UNION
         SELECT rd.downstream_rid FROM resource_dependencies rd JOIN down ON rd.upstream_rid = down.rid
       ) SELECT rid FROM down`, [rid]);
    return rows.map((r) => r.rid);
  }

  async getLineage(rid: string): Promise<{ upstream: string[]; downstream: string[] }> {
    const [u, d] = await Promise.all([this.getUpstream(rid), this.getDownstream(rid)]);
    return { upstream: u, downstream: d };
  }
}

export const resourceGraphService = new ResourceGraphService();
