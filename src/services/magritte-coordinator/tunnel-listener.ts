// ---------------------------------------------------------------------------
// B6 — Coordinator-side TCP tunnel listener (spec §B6 line 301).
//
// When a B4 worker (worker_type=agentProxy) calls the coordinator's
// internal `tunnels/open` route, this module:
//   1. Picks an agent from the target group via agents.repo.pickAgent().
//   2. Opens a local TCP listener bound to 127.0.0.1:NNNN.
//   3. Sends OPEN_TUNNEL_REQUEST to the chosen agent.
//   4. On worker connect, multiplexes bytes over WSS DATA frames.
// ---------------------------------------------------------------------------

import net from "node:net";
import { randomUUID } from "node:crypto";
import * as agentsRepo from "./agents.repo";
import type { ConnectedAgent, WsServerHandle } from "./ws-server";

export interface OpenTunnelArgs {
  groupRid: string;
  host: string;
  port: number;
}

export interface OpenTunnelResult {
  localPort: number;
  agentRid: string;
  close(): Promise<void>;
}

interface TunnelState {
  worker?: net.Socket;
  agent: ConnectedAgent;
  streamId?: string;
}

export class TunnelManager {
  private wsServer: WsServerHandle;
  private pending = new Map<string, (frame: any) => void>(); // requestId -> resolver

  constructor(wsServer: WsServerHandle) {
    this.wsServer = wsServer;
    wsServer.on("frame", ({ agentRid: _aid, frame }: any) => {
      if (frame.type === "OPEN_TUNNEL_RESPONSE") {
        const cb = this.pending.get(frame.requestId);
        if (cb) {
          cb(frame);
          this.pending.delete(frame.requestId);
        }
      }
    });
  }

  async open(args: OpenTunnelArgs): Promise<OpenTunnelResult> {
    const agent = await agentsRepo.pickAgent(args.groupRid);
    if (!agent) {
      throw new Error(`no connected agent in group ${args.groupRid}`);
    }
    // Find the live ConnectedAgent wrapper for the picked rid.
    const live = this.wsServer.agents().find((a) => a.rid === agent.rid);
    if (!live) {
      throw new Error(`picked agent ${agent.rid} is not currently live`);
    }
    const requestId = randomUUID();
    const respP = new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("OPEN_TUNNEL_REQUEST timeout"));
      }, 10_000);
      this.pending.set(requestId, (f) => {
        clearTimeout(t);
        resolve(f);
      });
    });
    live.send({
      type: "OPEN_TUNNEL_REQUEST",
      requestId,
      host: args.host,
      port: args.port,
    });
    const resp = await respP;
    if (!resp.ok) {
      throw new Error(`agent rejected tunnel: ${resp.reason ?? "denied"}`);
    }

    // Open a local TCP listener; bridge a single connection.
    const listener = net.createServer();
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", () => r()));
    const localPort = (listener.address() as net.AddressInfo).port;

    const state: TunnelState = { agent: live };
    listener.on("connection", (sock) => {
      state.worker = sock;
      sock.on("data", (chunk: Buffer) => {
        if (state.streamId) {
          live.send({
            type: "DATA",
            streamId: state.streamId,
            chunk: chunk.toString("base64"),
          });
        }
      });
      sock.on("close", () => {
        if (state.streamId) {
          live.send({ type: "CLOSE_STREAM", streamId: state.streamId });
        }
      });
    });

    void agentsRepo.adjustTunnelCount(live.rid, +1).catch(() => undefined);
    return {
      localPort,
      agentRid: live.rid,
      close: async () => {
        await new Promise<void>((r) => listener.close(() => r()));
        await agentsRepo.adjustTunnelCount(live.rid, -1).catch(() => undefined);
      },
    };
  }
}
