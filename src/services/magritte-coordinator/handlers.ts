// ---------------------------------------------------------------------------
// B6 — Coordinator agent CRUD handlers (spec §B6 line 303).
//
// Routes:
//   POST /api/v2/magritte/agents               -> register agent (issues joining token)
//   GET  /api/v2/magritte/agents               -> list agents in tenant
//   GET  /api/v2/magritte/agents/:rid          -> read agent
//   DELETE /api/v2/magritte/agents/:rid        -> deregister (close WSS)
//   POST /api/v2/magritte/agent-groups         -> create group
//   GET  /api/v2/magritte/agent-groups         -> list groups
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { pool } from "../../db";
import * as agentsRepo from "./agents.repo";

function tenantOf(req: Request): string {
  return (req as any).user?.tenant ?? "default";
}

export async function postAgent(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { groupRid, displayName } = req.body ?? {};
    if (!groupRid || !displayName) {
      res.status(400).json({
        errorCode: "INVALID_ARGUMENT",
        errorName: "Tellus:Magritte:InvalidAgent",
        parameters: { reason: "groupRid + displayName required" },
      });
      return;
    }
    const rid = `ri.magritte.main.agent.${randomUUID()}`;
    const token = randomUUID();
    await pool.query(
      `INSERT INTO magritte_agents(rid, group_rid, display_name, version, tags, status)
       VALUES ($1,$2,$3,'unknown','{}'::jsonb,'pending')`,
      [rid, groupRid, displayName],
    );
    // Token storage in v0 is a separate `magritte_agent_tokens` table; for now
    // return the token directly to the operator (one-time view).
    res.status(201).json({ rid, token });
  } catch (err) {
    next(err);
  }
}

export async function listAgents(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const groupRid = String(req.query.groupRid ?? "");
    if (!groupRid) {
      res.status(400).json({
        errorCode: "INVALID_ARGUMENT",
        errorName: "Tellus:Magritte:GroupRequired",
        parameters: {},
      });
      return;
    }
    const agents = await agentsRepo.listByGroup(groupRid);
    res.json({ agents });
  } catch (err) {
    next(err);
  }
}

export async function getAgent(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const r = await pool.query(
      `SELECT rid, group_rid AS "groupRid", display_name AS "displayName",
              version, tags, joined_at AS "joinedAt",
              last_heartbeat_at AS "lastHeartbeatAt",
              open_tunnels AS "openTunnels", status
         FROM magritte_agents
        WHERE rid = $1`,
      [req.params.rid],
    );
    if (r.rowCount === 0) {
      res.status(404).json({
        errorCode: "NOT_FOUND",
        errorName: "Tellus:Magritte:AgentNotFound",
        parameters: { rid: req.params.rid },
      });
      return;
    }
    res.json(r.rows[0]);
  } catch (err) {
    next(err);
  }
}

export async function deleteAgent(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await pool.query(`DELETE FROM magritte_agents WHERE rid=$1`, [
      req.params.rid,
    ]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function postAgentGroup(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { displayName, policy } = req.body ?? {};
    if (!displayName) {
      res.status(400).json({
        errorCode: "INVALID_ARGUMENT",
        errorName: "Tellus:Magritte:DisplayNameRequired",
        parameters: {},
      });
      return;
    }
    const rid = `ri.magritte.main.agent-group.${randomUUID()}`;
    await pool.query(
      `INSERT INTO magritte_agent_groups(rid, tenant, display_name, policy)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [rid, tenantOf(req), displayName, JSON.stringify(policy ?? {})],
    );
    res.status(201).json({ rid });
  } catch (err) {
    next(err);
  }
}

export async function listAgentGroups(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const r = await pool.query(
      `SELECT rid, display_name AS "displayName", policy, created_at AS "createdAt"
         FROM magritte_agent_groups
        WHERE tenant = $1
        ORDER BY created_at DESC`,
      [tenantOf(req)],
    );
    res.json({ agentGroups: r.rows });
  } catch (err) {
    next(err);
  }
}
