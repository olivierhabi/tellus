import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { Knex } from 'knex';

/** Guard flag to prevent double shutdown */
let shuttingDown = false;

/**
 * Check whether the server is currently shutting down.
 */
export function getIsShuttingDown(): boolean {
  return shuttingDown;
}

/**
 * Reset the shutting-down flag. Only intended for use in tests
 * where the module is reused across test runs without process exit.
 */
export function resetShuttingDown(): void {
  shuttingDown = false;
}

/**
 * Graceful shutdown with connection draining.
 *
 * 1. Close HTTP server (stop accepting new connections)
 * 2. Close WebSocket connections with code 1001 (Going Away)
 * 3. Reset any datasets stuck in "processing" status
 * 4. Drain the database connection pool
 * 5. Clean up temp files
 *
 * @param server - The HTTP server instance
 * @param db - The Knex database instance
 * @param wss - Optional WebSocket server instance
 */
export async function shutdown(
  server: HttpServer,
  db: Knex,
  wss?: WebSocketServer | null
): Promise<void> {
  // Prevent double shutdown
  if (shuttingDown) {
    console.log('[shutdown] Already shutting down, ignoring duplicate signal');
    return;
  }
  shuttingDown = true;

  console.log('[shutdown] Graceful shutdown initiated...');

  // Force exit after 15 seconds
  const forceExitTimer = setTimeout(() => {
    console.error('[shutdown] Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 15_000);
  forceExitTimer.unref();

  // Step 1: Close HTTP server (stop accepting new connections)
  await new Promise<void>((resolve) => {
    console.log('[shutdown] Closing HTTP server...');
    server.close((err) => {
      if (err) {
        console.error('[shutdown] Error closing HTTP server:', err.message);
      } else {
        console.log('[shutdown] HTTP server closed');
      }
      resolve();
    });
  });

  // Step 2: Close WebSocket connections
  if (wss) {
    console.log('[shutdown] Closing WebSocket connections...');
    const closePromises: Promise<void>[] = [];

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        closePromises.push(
          new Promise<void>((resolve) => {
            client.close(1001, 'Server shutting down');
            // Give clients a moment to acknowledge
            const timer = setTimeout(() => {
              client.terminate();
              resolve();
            }, 2000);
            client.on('close', () => {
              clearTimeout(timer);
              resolve();
            });
          })
        );
      }
    });

    await Promise.allSettled(closePromises);
    console.log('[shutdown] WebSocket connections closed');
  }

  // Step 3: Reset datasets stuck in "processing" to "pending"
  try {
    console.log('[shutdown] Resetting processing datasets...');
    const resetCount = await db('foundry_datasets')
      .where({ status: 'processing' })
      .update({ status: 'pending' });
    if (resetCount > 0) {
      console.log(`[shutdown] Reset ${resetCount} processing dataset(s) to pending`);
    }
  } catch (err) {
    console.error('[shutdown] Error resetting datasets:', (err as Error).message);
  }

  // Step 4: Drain the database connection pool
  try {
    console.log('[shutdown] Draining database pool...');
    await db.destroy();
    console.log('[shutdown] Database pool drained');
  } catch (err) {
    console.error('[shutdown] Error draining database pool:', (err as Error).message);
  }

  clearTimeout(forceExitTimer);
  console.log('[shutdown] Graceful shutdown complete');
}
