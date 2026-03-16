import { eventBus } from '@/websocket/eventBus';

/**
 * Safely emit a dataset-related event via the event bus.
 * Wraps in try-catch so emitting never breaks the caller.
 */
export function emitDatasetEvent(
  event: string,
  projectId: string,
  payload: unknown
): void {
  try {
    eventBus.emit('ws:event', { event, projectId, payload });
  } catch (error) {
    console.error(`Failed to emit event "${event}":`, error);
  }
}
