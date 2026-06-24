/**
 * F8 / B3 C-11..C-13 — WebSocket gateway for the collab event bus.
 *
 * Subscribes to `collabBus` per-(rid) and pushes JSON-encoded events
 * to connected clients. Inbound messages from clients are limited to
 * `presenceUpdate` (broadcast to peers); all durable mutations go over
 * the HTTP submitInstructions endpoint per spec §F8 C-04.
 *
 * Auth: Multipass JWT lifted from the `Sec-WebSocket-Protocol` header
 * (B3 C-12). In test mode (QUIVER_ALLOW_TEST_AUTH=1) accept the
 * `x-test-user` header on the upgrade request as the user subject.
 *
 * Close codes:
 *   4001 — token expired / invalid
 *   4002 — analysis not found
 *   4003 — rid format invalid
 *
 * Per D-42 the OT engine ships independently of WS; this gateway is a
 * transport-only adapter.
 */

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  collabBus,
  emitCollab,
  type CollabEvent,
  type PresenceUpdateEvent,
} from "./eventBus";
import {
  otCollabActiveSessions,
  otWsDisconnectsTotal,
} from "../metrics";
import type { TellusAuthService } from "../../tellusAuthService";
import { isQuiverTestAuthAllowed } from "../../../routes/quiver/testAuth";

// Largest inbound frame we will parse (presenceUpdate messages are tiny);
// caps memory a hostile client can force us to buffer per frame.
const MAX_WS_PAYLOAD_BYTES = 64 * 1024;

// Lazy singleton. We DYNAMICALLY import the auth service / db so that merely
// importing this transport module never triggers `foundryDb`'s import-time
// `requireSecret('PGPASSWORD')` side effect — the heavy deps load on first WS
// authentication at runtime, not at module load (keeps the module importable
// in unit tests without a full env).
let authService: TellusAuthService | null = null;
async function authSvc(): Promise<TellusAuthService> {
  if (!authService) {
    const [{ TellusAuthService: Svc }, { getKeycloakRealm }, foundryDbMod] =
      await Promise.all([
        import("../../tellusAuthService"),
        import("../../../auth/keycloakConfig"),
        import("../../../config/foundryDb"),
      ]);
    authService = new Svc(foundryDbMod.default as never, {
      kcUrl: process.env.KEYCLOAK_URL || "http://localhost:8086",
      kcRealm: getKeycloakRealm(),
      kcFrontendClientId:
        process.env.KEYCLOAK_FRONTEND_CLIENT_ID || "tellus-frontend",
    });
  }
  return authService;
}

const PATH_REGEX =
  /^\/quiver\/api\/v1\/analyses\/(ri\.tellus-quiver\.main\.analysis\.[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/stream$/u;

export interface QuiverWsOptions {
  /**
   * Resolves the user subject for an upgrade request. In production
   * this validates the Multipass JWT in `Sec-WebSocket-Protocol`.
   * Returning null causes a 4001 close.
   */
  resolveUser?: (req: IncomingMessage) => Promise<string | null> | string | null;
}

export interface AttachedQuiverWs {
  wss: WebSocketServer;
  /** Disconnect everything and stop listening on the upgrade event. */
  close: () => Promise<void>;
}

export function attachQuiverWs(
  http: HttpServer,
  opts: QuiverWsOptions = {},
): AttachedQuiverWs {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
  });
  const resolveUser = opts.resolveUser ?? defaultResolveUser;

  const upgradeHandler = async (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> => {
    const url = req.url ?? "";
    const m = url.match(PATH_REGEX);
    if (!m) {
      // Not a Quiver WS path; ignore so other handlers can pick up.
      return;
    }
    const rid = m[1];
    let user: string | null = null;
    try {
      user = await resolveUser(req);
    } catch {
      user = null;
    }
    if (!user) {
      socket.write(
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n",
      );
      socket.destroy();
      otWsDisconnectsTotal.inc({ reason: "unauthenticated" });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      bindClient(ws, { rid, userSubject: user! });
    });
  };

  http.on("upgrade", upgradeHandler);

  return {
    wss,
    async close() {
      http.off("upgrade", upgradeHandler);
      for (const client of wss.clients) {
        try { client.close(1001, "server_shutdown"); } catch {}
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

interface ClientCtx {
  rid: string;
  userSubject: string;
}

function bindClient(ws: WebSocket, ctx: ClientCtx): void {
  // Subscribe to the bus for this rid and forward.
  const send = (ev: CollabEvent): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // F8 C-03: serverRebase is per-recipient; only deliver to the
    // affected user.
    if (ev.kind === "serverRebase" && ev.toUserSubject !== ctx.userSubject) return;
    try {
      ws.send(JSON.stringify(ev));
    } catch {
      // Best-effort.
    }
  };
  const handler = (ev: CollabEvent) => send(ev);
  collabBus.on(`collab:${ctx.rid}`, handler);
  otCollabActiveSessions.inc();

  ws.on("message", (raw) => {
    // Inbound is presence-only per F8 C-04.
    let parsed: any;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (parsed?.kind !== "presenceUpdate") return;
    const ev: PresenceUpdateEvent = {
      kind: "presenceUpdate",
      rid: ctx.rid,
      userSubject: ctx.userSubject,
      cursor: parsed.cursor,
      selectedCardIds: Array.isArray(parsed.selectedCardIds)
        ? parsed.selectedCardIds.filter((s: any) => typeof s === "string")
        : [],
    };
    emitCollab(ev);
  });

  const cleanup = (reason: string) => {
    collabBus.off(`collab:${ctx.rid}`, handler);
    otCollabActiveSessions.dec();
    otWsDisconnectsTotal.inc({ reason });
  };
  ws.on("close", () => cleanup("client_close"));
  ws.on("error", () => cleanup("error"));
}


async function defaultResolveUser(
  req: IncomingMessage,
): Promise<string | null> {
  // Test-only header bypass, hard-gated to non-production (see testAuth.ts).
  if (isQuiverTestAuthAllowed()) {
    const u = req.headers["x-test-user"];
    if (typeof u === "string") return u;
    if (Array.isArray(u) && u.length > 0) return u[0];
  }
  // Parse `Sec-WebSocket-Protocol: bearer <jwt>` and VERIFY the token
  // (signature, issuer, expiry) against Keycloak before trusting any
  // identity. Fail-closed: any verification failure resolves to null, which
  // the upgrade handler turns into a 401 — we never mint a synthetic
  // principal from an unverified token.
  const proto = req.headers["sec-websocket-protocol"];
  const raw = Array.isArray(proto) ? proto.join(",") : proto;
  if (typeof raw !== "string") return null;
  const m = raw.match(/bearer\s+([A-Za-z0-9._~+/=-]+)/i);
  if (!m) return null;
  try {
    const svc = await authSvc();
    const claims = await svc.verifyAccessToken(m[1]);
    return claims.sub ?? null;
  } catch {
    return null;
  }
}
