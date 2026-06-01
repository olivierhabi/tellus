// ---------------------------------------------------------------------------
// B6 — Reconnecting WSS client (spec §B6 line 306).
//
// Connects to tellus-magritte-coordinator over WSS. Exponential backoff
// 10s → 20s → 30s cap (criterion 2; prod cap 300s via env TELLUS_AGENT_MAX_BACKOFF_MS).
// Subprotocol frame types:
//   HELLO {agentId, version, tags}
//   HEARTBEAT {ts}
//   OPEN_TUNNEL_REQUEST {requestId, host, port}
//   OPEN_TUNNEL_RESPONSE {requestId, ok, reason?}
//   DATA {streamId, chunk(base64)}
//   CLOSE_STREAM {streamId, reason?}
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";

const DEFAULT_BASE_DELAY = Number(process.env.TELLUS_AGENT_BASE_BACKOFF_MS ?? 10_000);
const DEFAULT_CAP_DELAY = Number(process.env.TELLUS_AGENT_MAX_BACKOFF_MS ?? 30_000);

export interface AgentIdentity {
  agentId: string;
  version: string;
  tags: Record<string, string>;
}

export type WsFrame =
  | { type: "HELLO"; agentId: string; version: string; tags: Record<string, string> }
  | { type: "HEARTBEAT"; ts: number }
  | { type: "OPEN_TUNNEL_REQUEST"; requestId: string; host: string; port: number }
  | { type: "OPEN_TUNNEL_RESPONSE"; requestId: string; ok: boolean; reason?: string }
  | { type: "DATA"; streamId: string; chunk: string }
  | { type: "CLOSE_STREAM"; streamId: string; reason?: string };

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  on(ev: string, cb: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
};

export class WsClient extends EventEmitter {
  private url: string;
  private identity: AgentIdentity;
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private hbTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(url: string, identity: AgentIdentity) {
    super();
    this.url = url;
    this.identity = identity;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.hbTimer) clearInterval(this.hbTimer);
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  send(frame: WsFrame): void {
    if (!this.ws) throw new Error("ws-client: not connected");
    this.ws.send(JSON.stringify(frame));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const WSCtor = await loadWsCtor();
      const ws = new WSCtor(this.url, { perMessageDeflate: true });
      this.ws = ws as unknown as WebSocketLike;
      ws.on("open", () => {
        this.attempt = 0;
        this.send({
          type: "HELLO",
          agentId: this.identity.agentId,
          version: this.identity.version,
          tags: this.identity.tags,
        });
        this.hbTimer = setInterval(() => {
          try {
            this.send({ type: "HEARTBEAT", ts: Date.now() });
          } catch {
            /* will reconnect */
          }
        }, 10_000);
        this.emit("connected");
      });
      ws.on("message", (raw: Buffer | string) => {
        try {
          const text = typeof raw === "string" ? raw : raw.toString("utf8");
          const f = JSON.parse(text) as WsFrame;
          this.emit("frame", f);
        } catch {
          /* drop malformed */
        }
      });
      ws.on("close", () => this.scheduleReconnect());
      ws.on("error", () => {
        try {
          ws.close();
        } catch {
          /* */
        }
      });
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.ws = null;
    if (this.stopped) return;
    const delay = Math.min(
      DEFAULT_CAP_DELAY,
      DEFAULT_BASE_DELAY * Math.pow(2, this.attempt),
    );
    this.attempt += 1;
    this.emit("reconnecting", { delayMs: delay, attempt: this.attempt });
    setTimeout(() => void this.connect(), delay).unref?.();
  }
}

async function loadWsCtor(): Promise<new (url: string, opts?: unknown) => unknown> {
  // Try `ws` package first. If unavailable, fall back to Node's built-in
  // WebSocket (Node 22+). Throws if neither is available.
  try {
    const mod: any = await import("ws");
    return mod.WebSocket ?? mod.default ?? mod;
  } catch {
    if (typeof (globalThis as any).WebSocket === "function") {
      return (globalThis as any).WebSocket;
    }
    throw new Error("no WebSocket implementation available");
  }
}
