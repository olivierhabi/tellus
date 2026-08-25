// ---------------------------------------------------------------------------
// Agent-proxy dispatch seam (B3/B6 boundary).
//
// A connection's `workerType` is either `foundryWorker` (Tellus opens the
// driver socket directly from the platform) or `agentProxy` (the socket is
// tunneled through a customer-hosted Magritte agent that has dialed into the
// coordinator). For agentProxy connections the platform must NOT open a direct
// socket — it must route through a live agent in the connection's agent group.
//
// This module is the single seam where that routing decision is made. Today it
// resolves a live agent via the coordinator registry (power-of-two-choices over
// connected agents) and fails closed with Tellus:Connectivity:AgentUnavailable
// when the group has no connected agent. The actual tunnel transport lives in
// the coordinator (B6); the pool layer consults this seam so an agentProxy
// connection can never silently fall back to a direct egress.
//
// F7 — IMPORTANT: the liveness gate above is the ONLY use of this seam today.
// Webhook execution, health-probe, and worker-fetch egress all originate from
// the backend Node process DIRECTLY (see webhooks/executor.ts and
// health/prober.ts); they do NOT consult this seam and do NOT tunnel through
// the agent. The connection's `settings.egressMode` records the operator's
// acknowledgement of this ("direct" default vs the future "agent-tunnel"), and
// every direct egress is recorded in `connectivity_egress_audit_log`. The
// pool layer's `assertAgentAvailable` gate is a liveness check only — it does
// not open a tunnel. The B6 tunnel transport is future work.
// ---------------------------------------------------------------------------

import { TellusError } from "../../../lib/errors/envelope";
import {
  AgentGroupRequired,
  AgentUnavailable,
} from "../../../lib/errors/connectivity.errors";
import * as agentsRepo from "../../magritte-coordinator/agents.repo";

export interface AgentBinding {
  /** RID of the chosen live agent. */
  agentRid: string;
  /** RID of the agent group the binding was resolved from. */
  groupRid: string;
}

/** Minimal connection shape this seam needs (decoupled from the full contract). */
export interface AgentProxyConnection {
  workerType: string;
  agentGroupRid?: string;
}

/**
 * Resolve a live agent for a group. Throws Tellus:Connectivity:AgentUnavailable
 * (502) when the group has no connected agent. A real dispatch would open a
 * tunnel through the returned agent; callers that only need a routability gate
 * can use assertAgentAvailable.
 */
export async function resolveAgentForGroup(
  groupRid: string,
): Promise<AgentBinding> {
  const agent = await agentsRepo.pickAgent(groupRid);
  if (!agent) {
    throw new TellusError(AgentUnavailable, { agentGroupRid: groupRid });
  }
  return { agentRid: agent.rid, groupRid };
}

/**
 * Gate an agentProxy connection before any socket is opened. No-op for
 * foundryWorker connections. For agentProxy: requires an agentGroupRid
 * (AgentGroupRequired) and a live agent in that group (AgentUnavailable).
 */
export async function assertAgentAvailable(
  conn: AgentProxyConnection,
): Promise<void> {
  if (conn.workerType !== "agentProxy") return;
  if (!conn.agentGroupRid) {
    throw new TellusError(AgentGroupRequired, {});
  }
  await resolveAgentForGroup(conn.agentGroupRid);
}
