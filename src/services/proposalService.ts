// proposalService — proposal lifecycle (B7.05+).
import { pool as defaultPool } from "../db";
import type { Pool, PoolClient } from "pg";

export interface Proposal {
  id: string;
  branchId: string;
  title: string;
  description: string | null;
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'MERGED' | 'CLOSED';
  openedBy: string | null;
  openedAt: Date;
  closedAt: Date | null;
}
function fromRow(r: Record<string, unknown>): Proposal {
  return {
    id: r.id as string,
    branchId: r.branch_id as string,
    title: r.title as string,
    description: (r.description as string | null) ?? null,
    status: r.status as Proposal['status'],
    openedBy: (r.opened_by as string | null) ?? null,
    openedAt: new Date(r.opened_at as string),
    closedAt: r.closed_at ? new Date(r.closed_at as string) : null,
  };
}

export class ProposalService {
  constructor(private readonly pool: Pool = defaultPool) {}

  async open(branchId: string, title: string, opts: { actorId?: string; description?: string } = {}): Promise<Proposal> {
    const { rows } = await this.pool.query(
      `INSERT INTO proposals (branch_id, title, description, opened_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [branchId, title, opts.description ?? null, opts.actorId ?? null],
    );
    return fromRow(rows[0]);
  }

  async getById(id: string): Promise<Proposal | null> {
    const { rows } = await this.pool.query(`SELECT * FROM proposals WHERE id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listByBranch(branchId: string): Promise<Proposal[]> {
    const { rows } = await this.pool.query(`SELECT * FROM proposals WHERE branch_id = $1 ORDER BY opened_at DESC`, [branchId]);
    return rows.map(fromRow);
  }

  async setStatus(id: string, status: Proposal['status']): Promise<Proposal | null> {
    const { rows } = await this.pool.query(
      `UPDATE proposals SET status = $2, closed_at = CASE WHEN $2 IN ('REJECTED','MERGED','CLOSED') THEN now() ELSE closed_at END
       WHERE id = $1 RETURNING *`,
      [id, status],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  /**
   * B7.06 — record an approval/rejection for a proposal.
   * Returns the updated proposal status. The proposal transitions to
   * APPROVED only when the count of APPROVED approvals meets the
   * required_count from the matching approval_policy (default: 1).
   * Any single REJECTED approval transitions it to REJECTED immediately.
   */
  async approve(
    proposalId: string,
    approverId: string,
    decision: 'APPROVED' | 'REJECTED',
    opts: { comment?: string } = {},
  ): Promise<Proposal | null> {
    const c: PoolClient = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `INSERT INTO proposal_approvals (proposal_id, approver_id, decision, comment)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (proposal_id, approver_id) DO UPDATE SET decision = EXCLUDED.decision, comment = EXCLUDED.comment, decided_at = now()`,
        [proposalId, approverId, decision, opts.comment ?? null],
      );
      // Look up proposal + branch + policy
      const { rows: pr } = await c.query<{ branch_id: string; project_rid: string }>(
        `SELECT p.branch_id, b.project_rid FROM proposals p JOIN branches b ON b.id = p.branch_id WHERE p.id = $1`,
        [proposalId],
      );
      if (pr.length === 0) { await c.query("COMMIT"); return null; }
      const required = await c.query<{ required_count: number }>(
        `SELECT required_count FROM approval_policies WHERE scope_rid = $1 ORDER BY created_at DESC LIMIT 1`,
        [pr[0].project_rid],
      );
      const requiredCount = required.rows[0]?.required_count ?? 1;
      const counts = await c.query<{ approved: number; rejected: number }>(
        `SELECT count(*) FILTER (WHERE decision='APPROVED')::int AS approved,
                count(*) FILTER (WHERE decision='REJECTED')::int AS rejected
         FROM proposal_approvals WHERE proposal_id = $1`,
        [proposalId],
      );
      let nextStatus: Proposal['status'] | null = null;
      if (counts.rows[0].rejected > 0) nextStatus = 'REJECTED';
      else if (counts.rows[0].approved >= requiredCount) nextStatus = 'APPROVED';
      let result;
      if (nextStatus) {
        const { rows } = await c.query(
          `UPDATE proposals SET status = $2,
             closed_at = CASE WHEN $2 IN ('REJECTED','CLOSED','MERGED') THEN now() ELSE closed_at END
             WHERE id = $1 RETURNING *`,
          [proposalId, nextStatus],
        );
        result = rows[0];
      } else {
        const { rows } = await c.query(`SELECT * FROM proposals WHERE id = $1`, [proposalId]);
        result = rows[0];
      }
      await c.query("COMMIT");
      return result ? fromRow(result) : null;
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }

  async listApprovals(proposalId: string): Promise<{ approverId: string; decision: 'APPROVED' | 'REJECTED'; comment: string | null }[]> {
    const { rows } = await this.pool.query<{ approver_id: string; decision: 'APPROVED' | 'REJECTED'; comment: string | null }>(
      `SELECT approver_id, decision, comment FROM proposal_approvals WHERE proposal_id = $1 ORDER BY decided_at`,
      [proposalId],
    );
    return rows.map((r) => ({ approverId: r.approver_id, decision: r.decision, comment: r.comment }));
  }
}

export const proposalService = new ProposalService();
