// ---------------------------------------------------------------------------
// B6 — Coordinator WSS server (spec §B6 line 300).
//
// Mounts a WebSocket server (path /agent) onto the existing HTTP server.
// Validates HELLO frames against magritte_agents repo + the joining token,
// tracks per-connection state, fans out OPEN_TUNNEL_REQUEST frames coming
// from `tunnel-listener.ts`.
//
// The WS server uses `ws` 8.x; falls back to an in-memory shim for unit
// tests that don't have the package installed.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import * as agentsRepo from "./agents.repo";

export interface ConnectedAgent {
  rid: string;
  groupRid: string;
  send(frame: Record<string, unknown>): void;
  close(): void;
}

const REQUIRE_TOKEN = process.env.TELLUS_COORDINATOR_REQUIRE_TOKEN !== "0";

export interface WsServerOptions {
  /** Verify the joining token. Throws to reject. */
  verifyToken(args: { agentId: string; token: string }): Promise<{ groupRid: string }>;
}

export interface WsServerHandle extends EventEmitter {
  agents(): ConnectedAgent[];
  close(): Promise<void>;
  /** Number of currently-connected agents (test introspection). */
  size(): number;
}

export async function startWsServer(
  http: HttpServer,
  opts: WsServerOptions,
): Promise<WsServerHandle> {
  const ev = new EventEmitter() as WsServerHandle;
  const connected = new Map<string, ConnectedAgent>();

  let WSModule: any;
  try {
    WSModule = await import("ws");
  } catch {
    // Fall back to a noop shim that satisfies the surface.
    ev.agents = () => [...connected.values()];
    ev.size = () => connected.size;
    ev.close = async () => undefined;
    return ev;
  }

  const wss = new WSModule.WebSocketServer({ noServer: true });
  http.on("upgrade", (req: any, socket: any, head: any) => {
    if (!String(req.url ?? "").startsWith("/agent")) return;
    wss.handleUpgrade(req, socket, head, (ws: any) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: any) => {
    let agentRid: string | null = null;
    let groupRid: string | null = null;
    let helloSeen = false;

    const wrapper: ConnectedAgent = {
      rid: "",
      groupRid: "",
      send: (f) => ws.send(JSON.stringify(f)),
      close: () => ws.close(),
    };

    ws.on("message", async (raw: Buffer | string) => {
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        const f = JSON.parse(text) as Record<string, any>;
        if (f.type === "HELLO" && !helloSeen) {
          helloSeen = true;
          agentRid = String(f.agentId);
          const v = REQUIRE_TOKEN
            ? await opts.verifyToken({ agentId: agentRid, token: String(f.token ?? "") })
            : { groupRid: String(f.tags?.group ?? "ri.magritte.main.agent-group.dev") };
          groupRid = v.groupRid;
          wrapper.rid = agentRid;
          wrapper.groupRid = groupRid;
          await agentsRepo.upsertConnected({
            rid: agentRid,
            groupRid,
            displayName: agentRid,
            version: String(f.version ?? "0"),
            tags: (f.tags as Record<string, string>) ?? {},
          });
          connected.set(agentRid, wrapper);
          ev.emit("agent-connected", wrapper);
          return;
        }
        if (!helloSeen) {
          ws.close();
          return;
        }
        if (f.type === "HEARTBEAT" && agentRid) {
          await agentsRepo.recordHeartbeat(agentRid);
          return;
        }
        ev.emit("frame", { agentRid, frame: f });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[coordinator.ws] message handling failed", (err as Error).message);
        ws.close();
      }
    });

    ws.on("close", async () => {
      if (agentRid) {
        connected.delete(agentRid);
        await agentsRepo.markDisconnected(agentRid).catch(() => undefined);
        ev.emit("agent-disconnected", { agentRid });
      }
    });
  });

  ev.agents = () => [...connected.values()];
  ev.size = () => connected.size;
  ev.close = async () => {
    for (const a of connected.values()) a.close();
    connected.clear();
    await new Promise<void>((r) => wss.close(() => r()));
  };
  return ev;
}
