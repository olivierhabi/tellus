import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { eventBus } from './eventBus';

interface ClientState {
  ws: WebSocket;
  subscribedProjects: Set<string>;
  isAlive: boolean;
}

let wss: WebSocketServer | null = null;

export function initWebSocketServer(httpServer: HttpServer): WebSocketServer {
  if (wss) {
    console.warn('[websocket] WebSocket server already initialized, closing previous instance');
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
          state.subscribedProjects.add(msg.projectId);
          ws.send(JSON.stringify({ type: 'subscribed', projectId: msg.projectId }));
        } else if (msg.action === 'unsubscribe' && msg.projectId) {
          state.subscribedProjects.delete(msg.projectId);
          ws.send(JSON.stringify({ type: 'unsubscribed', projectId: msg.projectId }));
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => { clients.delete(ws); });
    ws.on('error', () => { clients.delete(ws); });
  });

  // Forward EventBus events to subscribed WebSocket clients
  eventBus.on('ws:event', (data: { event: string; projectId: string | null; payload: unknown }) => {
    clients.forEach((state) => {
      if (state.ws.readyState === WebSocket.OPEN) {
        if (!data.projectId || state.subscribedProjects.has(data.projectId)) {
          state.ws.send(JSON.stringify(data));
        }
      }
    });
  });

  wss.on('close', () => { clearInterval(heartbeatInterval); });

  console.log('[websocket] WebSocket server initialized on /ws');
  return wss;
}

export function getWss(): WebSocketServer | null {
  return wss;
}
