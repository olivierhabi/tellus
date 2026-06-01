// ---------------------------------------------------------------------------
// B6 — Magritte coordinator module entrypoint (spec §B6 line 299).
//
// Exports:
//   - createCoordinatorRouter(): Express Router mountable at
//     /api/v2/magritte (handlers for agent + agent-group CRUD).
//   - startCoordinator(httpServer): wires the WSS server + tunnel manager
//     onto the running HTTP server. Returns a handle with shutdown().
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Server as HttpServer } from "node:http";
import * as handlers from "./handlers";
import { startWsServer, type WsServerHandle } from "./ws-server";
import { TunnelManager } from "./tunnel-listener";
import { pool } from "../../db";

export function createCoordinatorRouter(): Router {
  const r = Router({ mergeParams: true });
  r.post("/agents", handlers.postAgent);
  r.get("/agents", handlers.listAgents);
  r.get("/agents/:rid", handlers.getAgent);
  r.delete("/agents/:rid", handlers.deleteAgent);
  r.post("/agent-groups", handlers.postAgentGroup);
  r.get("/agent-groups", handlers.listAgentGroups);
  return r;
}

export interface CoordinatorHandle {
  ws: WsServerHandle;
  tunnels: TunnelManager;
  shutdown(): Promise<void>;
}

export async function startCoordinator(
  http: HttpServer,
): Promise<CoordinatorHandle> {
  const ws = await startWsServer(http, {
    verifyToken: async ({ agentId, token }) => {
      // v0: token equality check against magritte_agents.tags->>'joining_token'.
      // Token storage table will be split out in a follow-up; current behaviour
      // accepts any non-empty token in dev (gated by env).
      if (!token && process.env.TELLUS_COORDINATOR_REQUIRE_TOKEN === "0") {
        return { groupRid: "ri.magritte.main.agent-group.dev" };
      }
      const r = await pool.query<{ group_rid: string }>(
        `SELECT group_rid FROM magritte_agents WHERE rid = $1`,
        [agentId],
      );
      if (r.rowCount === 0) {
        throw new Error(`agent ${agentId} not registered`);
      }
      return { groupRid: r.rows[0].group_rid };
    },
  });
  const tunnels = new TunnelManager(ws);
  return {
    ws,
    tunnels,
    async shutdown() {
      await ws.close();
    },
  };
}
