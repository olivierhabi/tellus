import { EventEmitter } from 'events';

/**
 * WebSocket event interface for cross-service communication.
 */
export interface WSEvent {
  event: string;
  projectId: string | null;
  payload: unknown;
}

/**
 * Singleton EventEmitter for cross-service events (BE-012 stub).
 */
class EventBus extends EventEmitter {
  constructor() {
    super();
    // Increase max listeners to avoid warnings in large apps
    this.setMaxListeners(50);
  }
}

export const eventBus = new EventBus();
