import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Request, Response } from "express";
import { eventBus } from './eventBus';
import { requireTellusAuth } from "../middleware/tellusAuth";
import {
  securityContext,
  type SecurityContext,
} from "../middleware/securityContext";
import { resolveRequestTenant } from "../utils/requestTenant";
import { parseObjectSet } from "../services/oss/objectSetDefinition";
import {
  acknowledgeCursor,
  closeOwnedSubscription,
  createDurableSubscription,
  ensureDurableSubscriptionEventBridge,
  getOwnedSubscription,
  loadAuthorizedEventObject,
  replayEvents,
  type DurableSubscription,
} from "../services/oss/durableSubscriptions";
import { recordOssV2AuditBestEffort } from "../services/oss/audit";

interface ClientState {
  ws: WebSocket;
  subscribedProjects: Set<string>;
  /**
   * FOUNDRY-GAPS §5 (Object Storage V2) — object-level subscriptions.
   * Topics are `${ontologyId}:${objectTypeApiName}` or `${ontologyId}:*`
   * for every object type in an ontology. Events carrying an
   * `objectTopic` route ONLY to clients subscribed to that topic — they
   * never broadcast, so object churn doesn't spam project subscribers.
   */
  subscribedObjectTopics: Set<string>;
  security: SecurityContext | null;
  tenantId: string | null;
  durableSubscriptions: Map<string, {
    subscription: DurableSubscription;
    cursor: number;
  }>;
  durablePoller: NodeJS.Timeout | null;
  isAlive: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_TYPE_RE = /^[A-Za-z0-9_-]{1,255}$/;

export interface RoutableWsEvent {
  event: string;
  projectId: string | null;
  /** Present on object-level events; absent on project/broadcast events. */
  objectTopic?: string;
  payload: unknown;
}

/**
 * Pure routing decision — exported for unit tests.
 * Object-topic events deliver only to exact-topic or ontology-wildcard
 * subscribers; everything else keeps the legacy project/broadcast rule.
 */
export function shouldDeliver(
  event: RoutableWsEvent,
  state: Pick<ClientState, 'subscribedProjects' | 'subscribedObjectTopics'>,
): boolean {
  if (event.objectTopic) {
    if (state.subscribedObjectTopics.has(event.objectTopic)) return true;
    const ontologyId = event.objectTopic.split(':')[0];
    return state.subscribedObjectTopics.has(`${ontologyId}:*`);
  }
  return !event.projectId || state.subscribedProjects.has(event.projectId);
}

/**
 * Validate + apply an object-subscription message. Returns the reply to
 * send, or null when the message is not an object-subscription action.
 * Exported for unit tests.
 */
export function handleObjectSubscription(
  state: Pick<ClientState, 'subscribedObjectTopics'>,
  msg: { action?: string; ontologyId?: string; objectType?: string },
): { type: string; [k: string]: unknown } | null {
  if (msg.action !== 'subscribeObjects' && msg.action !== 'unsubscribeObjects') {
    return null;
  }
  if (!msg.ontologyId || !UUID_RE.test(msg.ontologyId)) {
    return { type: 'error', message: 'Invalid ontologyId format' };
  }
  if (msg.objectType !== undefined && !OBJECT_TYPE_RE.test(msg.objectType)) {
    return { type: 'error', message: 'Invalid objectType format' };
  }
  const topic = `${msg.ontologyId}:${msg.objectType ?? '*'}`;
  if (msg.action === 'subscribeObjects') {
    state.subscribedObjectTopics.add(topic);
    return { type: 'subscribedObjects', topic };
  }
  state.subscribedObjectTopics.delete(topic);
  return { type: 'unsubscribedObjects', topic };
}

let wss: WebSocketServer | null = null;
let currentEventHandler: ((...args: unknown[]) => void) | null = null;

async function authenticateUpgrade(request: Request): Promise<boolean> {
  const cookieHeader = request.headers.cookie ?? "";
  request.cookies = Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => Boolean(key && value))
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const response = {
      status: () => response,
      json: () => {
        finish(false);
        return response;
      },
    } as unknown as Response;
    void requireTellusAuth()(request, response, () => {
      (request as Request & { auth?: unknown }).auth = request.tellusClaims;
      securityContext(request, response, () => finish(Boolean(request.security)));
    });
  });
}

function durableStreamPath(pathname: string): {
  ontology: string;
} | null {
  const match = pathname.match(
    /^\/api\/v2\/ontologies\/([^/]+)\/objectSets\/stream$/,
  );
  return match ? { ontology: decodeURIComponent(match[1]!) } : null;
}

export function initWebSocketServer(httpServer: HttpServer): WebSocketServer {
  ensureDurableSubscriptionEventBridge();
  if (wss) {
    console.warn('[websocket] WebSocket server already initialized, closing previous instance');
    // Remove the stale eventBus listener before closing
    if (currentEventHandler) {
      eventBus.removeListener('ws:event', currentEventHandler);
      currentEventHandler = null;
    }
    wss.close();
  }
  // Use noServer mode to prevent ws library from auto-handling upgrades
  // This allows other upgrade handlers to process different paths
  wss = new WebSocketServer({ noServer: true });

  // Handle upgrade requests for /ws path
  // Use prependListener to ensure this runs before other handlers
  httpServer.prependListener('upgrade', async (request, socket, head) => {
    const pathname = request.url ? new URL(request.url, `http://127.0.0.1:3000`).pathname : '';
    console.log(`[websocket] Upgrade event for pathname: ${pathname}`);
    const durablePath = durableStreamPath(pathname);
    if (durablePath) {
      const authenticated = await authenticateUpgrade(
        request as unknown as Request,
      );
      if (!authenticated) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      (request as typeof request & {
        durableOntology?: string;
      }).durableOntology = durablePath.ontology;
      wss!.handleUpgrade(request, socket, head, (ws) => {
        wss!.emit('connection', ws, request);
      });
      return;
    }
    if (pathname === '/ws') {
      console.log('[websocket] Handling /ws upgrade');
      wss!.handleUpgrade(request, socket, head, (ws) => {
        wss!.emit('connection', ws, request);
      });
    }
  });

  const clients = new Map<WebSocket, ClientState>();

  // Heartbeat interval (15s)
  const heartbeatInterval = setInterval(() => {
    clients.forEach((state, ws) => {
      if (!state.isAlive) {
        clients.delete(ws);
        ws.terminate();
        return;
      }
      state.isAlive = false;
      ws.ping();
    });
  }, 15000);

  wss.on('connection', (ws, request) => {
    const expressRequest = request as unknown as Request;
    const security = expressRequest.security ?? null;
    const state: ClientState = {
      ws,
      subscribedProjects: new Set(),
      subscribedObjectTopics: new Set(),
      security,
      tenantId: security ? resolveRequestTenant(expressRequest) : null,
      durableSubscriptions: new Map(),
      durablePoller: null,
      isAlive: true,
    };
    clients.set(ws, state);

    ws.on('pong', () => { state.isAlive = true; });

    const emitDurableUpdates = async () => {
      if (!state.security || !state.tenantId) return;
      for (const slot of state.durableSubscriptions.values()) {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 1_000_000) {
          ws.close(1013, "slow consumer");
          return;
        }
        const replay = await replayEvents(slot.subscription, slot.cursor);
        if (replay.expired) {
          for (const objectType of slot.subscription.dependencyTypes) {
            ws.send(JSON.stringify({
              type: "refreshObjectSet",
              id: slot.subscription.id,
              objectType,
              cursor: String(replay.cursor),
            }));
          }
          slot.cursor = replay.cursor;
          continue;
        }
        const updates = [];
        const eventIds: string[] = [];
        for (const event of replay.events) {
          const object = await loadAuthorizedEventObject({
            subscription: slot.subscription,
            event,
            security: state.security,
          });
          updates.push({
            type: "object",
            object:
              object ?? {
                __apiName: event.objectType,
                __primaryKey: event.primaryKey,
                ...(event.objectRid ? { __rid: event.objectRid } : {}),
              },
            state:
              event.state === "REMOVED" || !object
                ? "REMOVED"
                : "ADDED_OR_UPDATED",
          });
          eventIds.push(event.eventId);
        }
        if (updates.length > 0) {
          ws.send(JSON.stringify({
            type: "objectSetChanged",
            id: slot.subscription.id,
            updates,
            cursor: String(replay.cursor),
            eventIds,
          }));
          slot.cursor = replay.cursor;
        }
      }
    };

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribeRequests" || Array.isArray(msg.requests)) {
          if (!state.security || !state.tenantId) {
            ws.send(JSON.stringify({
              type: "subscribeResponses",
              id: msg.id,
              responses: [{
                type: "error",
                errors: [{ error: "AuthenticationRequired", args: [] }],
              }],
            }));
            return;
          }
          const ontologyId = (request as typeof request & {
            durableOntology?: string;
          }).durableOntology;
          if (!ontologyId) {
            ws.send(JSON.stringify({ type: "error", message: "Durable ObjectSet subscriptions require the v2 stream path." }));
            return;
          }
          const url = new URL(request.url ?? "/", "http://localhost");
          const requested = Array.isArray(msg.requests) ? msg.requests : [];
          const responses = [];
          for (const item of requested) {
            try {
              const objectSet = parseObjectSet(item.objectSet);
              const subscription = await createDurableSubscription({
                tenantId: state.tenantId,
                ontologyId,
                ownerUserId: state.security.userId,
                branchId: url.searchParams.get("branch"),
                transactionId: url.searchParams.get("transactionId"),
                scenarioRid: url.searchParams.get("scenarioRid"),
                objectSet,
                propertySet: item.propertySet ?? [],
                referenceSet: item.referenceSet ?? [],
                requestId: String(msg.id ?? ""),
              });
              state.durableSubscriptions.set(subscription.id, {
                subscription,
                cursor: subscription.lastAcknowledgedSequence,
              });
              responses.push({ type: "success", id: subscription.id });
            } catch (error) {
              responses.push({
                type: "error",
                errors: [{
                  error:
                    (error as { errorName?: string }).errorName ??
                    "InvalidObjectSetSubscription",
                  args: [],
                }],
              });
            }
          }
          ws.send(JSON.stringify({
            type: "subscribeResponses",
            id: msg.id,
            responses,
          }));
          if (!state.durablePoller) {
            state.durablePoller = setInterval(() => {
              void emitDurableUpdates().catch((error: unknown) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: "subscriptionClosed",
                    id: "stream",
                    cause: {
                      type: "error",
                      error: {
                        error:
                          (error as { errorName?: string }).errorName ??
                          "SubscriptionReplayError",
                        args: [],
                      },
                    },
                  }));
                }
              });
            }, 500);
          }
          return;
        }
        if (msg.type === "resume") {
          if (!state.security || !state.tenantId) return;
          const subscription = await getOwnedSubscription({
            subscriptionId: String(msg.subscriptionId),
            tenantId: state.tenantId,
            userId: state.security.userId,
          });
          const cursor = Number(msg.cursor ?? subscription.lastAcknowledgedSequence);
          state.durableSubscriptions.set(subscription.id, {
            subscription,
            cursor: Number.isSafeInteger(cursor)
              ? cursor
              : subscription.lastAcknowledgedSequence,
          });
          recordOssV2AuditBestEffort({
            eventType: "subscription_resume",
            tenantId: state.tenantId,
            ontologyId: subscription.ontologyId,
            userId: state.security.userId,
            branchId: subscription.branchId,
            transactionId: subscription.transactionId,
            scenarioRid: subscription.scenarioRid,
            requestId: String(msg.id ?? ""),
            outcome: "success",
            parameters: {
              subscriptionId: subscription.id,
              cursor: Number.isSafeInteger(cursor)
                ? cursor
                : subscription.lastAcknowledgedSequence,
            },
          });
          ws.send(JSON.stringify({
            type: "subscribeResponses",
            id: msg.id ?? "resume",
            responses: [{ type: "success", id: subscription.id }],
          }));
          if (!state.durablePoller) {
            state.durablePoller = setInterval(
              () => void emitDurableUpdates(),
              500,
            );
          }
          return;
        }
        if (msg.type === "ackCursor") {
          if (!state.security || !state.tenantId) return;
          await acknowledgeCursor({
            subscriptionId: String(msg.subscriptionId),
            tenantId: state.tenantId,
            userId: state.security.userId,
            cursor: Number(msg.cursor),
          });
          return;
        }
        if (msg.type === "unsubscribe") {
          if (!state.security || !state.tenantId) return;
          await closeOwnedSubscription({
            subscriptionId: String(msg.subscriptionId),
            tenantId: state.tenantId,
            userId: state.security.userId,
          });
          state.durableSubscriptions.delete(String(msg.subscriptionId));
          ws.send(JSON.stringify({
            type: "subscriptionClosed",
            id: String(msg.subscriptionId),
            cause: { type: "reason", reason: "USER_CLOSED" },
          }));
          return;
        }
        const objectReply = handleObjectSubscription(state, msg);
        if (objectReply) {
          ws.send(JSON.stringify(objectReply));
        } else if (msg.action === 'subscribe' && msg.projectId) {
          if (!UUID_RE.test(msg.projectId)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid projectId format' }));
          } else {
            state.subscribedProjects.add(msg.projectId);
            ws.send(JSON.stringify({ type: 'subscribed', projectId: msg.projectId }));
          }
        } else if (msg.action === 'unsubscribe' && msg.projectId) {
          if (!UUID_RE.test(msg.projectId)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid projectId format' }));
          } else {
            state.subscribedProjects.delete(msg.projectId);
            ws.send(JSON.stringify({ type: 'unsubscribed', projectId: msg.projectId }));
          }
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (state.durablePoller) clearInterval(state.durablePoller);
    });
    ws.on('error', () => {
      clients.delete(ws);
      if (state.durablePoller) clearInterval(state.durablePoller);
    });
  });

  // Forward EventBus events to subscribed WebSocket clients.
  // Store the handler reference so it can be removed on re-initialization.
  currentEventHandler = (data: unknown) => {
    const event = data as RoutableWsEvent;
    clients.forEach((state) => {
      if (state.ws.readyState === WebSocket.OPEN && shouldDeliver(event, state)) {
        state.ws.send(JSON.stringify(event));
      }
    });
  };
  eventBus.on('ws:event', currentEventHandler);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
    if (currentEventHandler) {
      eventBus.removeListener('ws:event', currentEventHandler);
      currentEventHandler = null;
    }
  });

  console.log('[websocket] WebSocket server initialized on /ws');
  return wss;
}

export function getWss(): WebSocketServer | null {
  return wss;
}
