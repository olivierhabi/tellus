import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { eventBus } from './eventBus';

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

export function initWebSocketServer(httpServer: HttpServer): WebSocketServer {
  if (wss) {
    console.warn('[websocket] WebSocket server already initialized, closing previous instance');
    // Remove the stale eventBus listener before closing
    if (currentEventHandler) {
      eventBus.removeListener('ws:event', currentEventHandler);
      currentEventHandler = null;
    }
    wss.close();
  }
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
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

  wss.on('connection', (ws) => {
    const state: ClientState = {
      ws,
      subscribedProjects: new Set(),
      subscribedObjectTopics: new Set(),
      isAlive: true,
    };
    clients.set(ws, state);

    ws.on('pong', () => { state.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
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

    ws.on('close', () => { clients.delete(ws); });
    ws.on('error', () => { clients.delete(ws); });
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
