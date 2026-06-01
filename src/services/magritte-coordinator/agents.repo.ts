// ---------------------------------------------------------------------------
// B6 — Coordinator-side agent registry (spec §B6 line 302).
//
// Tracks every agent that has dialed in: which group it belongs to, its last
// heartbeat, current openTunnels count (used for power-of-two-choices load
// balancing — criterion 4).
// ---------------------------------------------------------------------------

import { pool } from "../../db";

export interface AgentRow {
  rid: string;
  groupRid: string;
  displayName: string;
  version: string;
  tags: Record<string, string>;
  joinedAt: string;
  lastHeartbeatAt: string | null;
  openTunnels: number;
  status: "pending" | "connected" | "disconnected" | "draining";
}

export async function upsertConnected(args: {
  rid: string;
  groupRid: string;
  displayName: string;
  version: string;
  tags: Record<string, string>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO magritte_agents(rid, group_rid, display_name, version, tags, last_heartbeat_at, status)
     VALUES ($1,$2,$3,$4,$5::jsonb, now(), 'connected')
     ON CONFLICT (rid) DO UPDATE
       SET last_heartbeat_at = now(),
           status = 'connected',
           version = EXCLUDED.version,
           tags = EXCLUDED.tags`,
    [args.rid, args.groupRid, args.displayName, args.version, JSON.stringify(args.tags)],
  );
}

export async function recordHeartbeat(rid: string): Promise<void> {
  await pool.query(
    `UPDATE magritte_agents
        SET last_heartbeat_at = now()
      WHERE rid = $1`,
    [rid],
  );
}

export async function markDisconnected(rid: string): Promise<void> {
  await pool.query(
    `UPDATE magritte_agents
        SET status = 'disconnected'
      WHERE rid = $1`,
    [rid],
  );
}

export async function adjustTunnelCount(rid: string, delta: number): Promise<void> {
  await pool.query(
    `UPDATE magritte_agents
        SET open_tunnels = GREATEST(0, open_tunnels + $2)
      WHERE rid = $1`,
    [rid, delta],
  );
}

export async function listByGroup(groupRid: string): Promise<AgentRow[]> {
  const r = await pool.query<AgentRow>(
    `SELECT rid, group_rid AS "groupRid", display_name AS "displayName",
            version, tags, joined_at AS "joinedAt",
            last_heartbeat_at AS "lastHeartbeatAt",
            open_tunnels AS "openTunnels", status
       FROM magritte_agents
      WHERE group_rid = $1
      ORDER BY joined_at ASC`,
    [groupRid],
  );
  return r.rows;
}

/** Pick an agent via power-of-two-choices on openTunnels (criterion 4). */
export async function pickAgent(groupRid: string): Promise<AgentRow | null> {
  const candidates = (await listByGroup(groupRid)).filter(
    (a) => a.status === "connected",
  );
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const a = candidates[Math.floor(Math.random() * candidates.length)];
  const b = candidates[Math.floor(Math.random() * candidates.length)];
  return a.openTunnels <= b.openTunnels ? a : b;
}
