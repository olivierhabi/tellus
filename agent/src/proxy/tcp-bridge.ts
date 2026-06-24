// ---------------------------------------------------------------------------
// B6 — TCP bridge inside the agent (spec §B6 line 307).
//
// When the coordinator asks the agent to open a tunnel to a target host:port,
// the bridge:
//   1. Validates against the agent allowlist.
//   2. Opens a TCP socket to the target.
//   3. Multiplexes bidirectional bytes over the WSS DATA frames.
//
// Each tunnel session is identified by a streamId; the agent maintains a
// Map<streamId, net.Socket>.
// ---------------------------------------------------------------------------

import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  assertCanReach,
  type Allowlist,
  AgentAllowlistDenied,
} from "../allowlist";
import type { WsClient, WsFrame } from "../tunnel/ws-client";

export class TcpBridge {
  private sockets = new Map<string, net.Socket>();
  private allow: Allowlist;
  private ws: WsClient;

  constructor(ws: WsClient, allow: Allowlist) {
    this.ws = ws;
    this.allow = allow;
    ws.on("frame", (f: WsFrame) => this.onFrame(f));
  }

  private onFrame(f: WsFrame): void {
    if (f.type === "OPEN_TUNNEL_REQUEST") {
      this.handleOpen(f);
    } else if (f.type === "DATA") {
      const sock = this.sockets.get(f.streamId);
      if (sock) sock.write(Buffer.from(f.chunk, "base64"));
    } else if (f.type === "CLOSE_STREAM") {
      const sock = this.sockets.get(f.streamId);
      if (sock) sock.end();
      this.sockets.delete(f.streamId);
    }
  }

  private handleOpen(f: Extract<WsFrame, { type: "OPEN_TUNNEL_REQUEST" }>): void {
    try {
      assertCanReach(this.allow, f.host, f.port);
    } catch (err) {
      const reason =
        err instanceof AgentAllowlistDenied ? err.message : "denied";
      this.ws.send({
        type: "OPEN_TUNNEL_RESPONSE",
        requestId: f.requestId,
        ok: false,
        reason,
      });
      return;
    }
    const streamId = randomUUID();
    const sock = net.createConnection({ host: f.host, port: f.port });
    sock.on("connect", () => {
      this.sockets.set(streamId, sock);
      this.ws.send({
        type: "OPEN_TUNNEL_RESPONSE",
        requestId: f.requestId,
        ok: true,
      });
    });
    sock.on("data", (buf: Buffer) => {
      this.ws.send({
        type: "DATA",
        streamId,
        chunk: buf.toString("base64"),
      });
    });
    sock.on("error", (err) => {
      this.ws.send({
        type: "CLOSE_STREAM",
        streamId,
        reason: err.message,
      });
      this.sockets.delete(streamId);
    });
    sock.on("close", () => {
      this.ws.send({ type: "CLOSE_STREAM", streamId });
      this.sockets.delete(streamId);
    });
  }

  closeAll(): void {
    for (const sock of this.sockets.values()) sock.destroy();
    this.sockets.clear();
  }
}
