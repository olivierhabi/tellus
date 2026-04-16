import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { eventBus } from './eventBus';

interface ClientState {
  ws: WebSocket;
  subscribedProjects: Set<string>;
  isAlive: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const state: ClientState = { ws, subscribedProjects: new Set(), isAlive: true };
    clients.set(ws, state);

    ws.on('pong', () => { state.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'subscribe' && msg.projectId) {
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
    const event = data as { event: string; projectId: string | null; payload: unknown };
    clients.forEach((state) => {
      if (state.ws.readyState === WebSocket.OPEN) {
        if (!event.projectId || state.subscribedProjects.has(event.projectId)) {
          state.ws.send(JSON.stringify(event));
        }
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
