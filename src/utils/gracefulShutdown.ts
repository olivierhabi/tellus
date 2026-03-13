// ---------------------------------------------------------------------------
// Graceful Shutdown Handler (Task 21)
//
// Manages the orderly shutdown of the application when receiving
// SIGTERM or SIGINT signals. Ensures all in-flight requests complete,
// database connections are properly drained, and external clients
// are disconnected before the process exits.
//
// Usage:
//   import { setupGracefulShutdown } from "./utils/gracefulShutdown";
//   const server = app.listen(PORT);
//   setupGracefulShutdown(server, pool, opensearchClient);
//
// Run self-tests: npx tsx src/utils/gracefulShutdown.ts
// ---------------------------------------------------------------------------

import type { Server } from "http";
import type { Pool } from "pg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShutdownOptions {
  /** Maximum time to wait for in-flight requests to complete (ms). Default 30000. */
  timeout?: number;
  /** Callback invoked before shutdown starts (for cleanup tasks). */
  onShutdownStart?: (signal: string) => void;
  /** Callback invoked after shutdown completes. */
  onShutdownComplete?: () => void;
  /** Custom logger function. Defaults to console.log. */
  logger?: (message: string) => void;
}

export interface ShutdownState {
  /** Whether a shutdown is currently in progress. */
  isShuttingDown: boolean;
  /** The signal that triggered the shutdown, if any. */
  signal: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Set up graceful shutdown handlers for SIGTERM and SIGINT.
 *
 * Shutdown sequence:
 *   1. Log the signal and invoke onShutdownStart callback
 *   2. Stop accepting new connections (server.close())
 *   3. Wait for in-flight requests to complete (with timeout)
 *   4. Close the PostgreSQL connection pool
 *   5. Close the OpenSearch client (if provided)
 *   6. Invoke onShutdownComplete callback
 *   7. Exit with code 0
 *
 * If the shutdown takes longer than the timeout, it force-exits with code 1.
 *
 * Returns a ShutdownState object that can be inspected to check if a
 * shutdown is in progress (useful for health checks).
 */
export function setupGracefulShutdown(
  server: Server,
  pgPool: Pool,
  opensearchClient?: { close?: () => Promise<void> | void },
  options: ShutdownOptions = {}
): ShutdownState {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    onShutdownStart,
    onShutdownComplete,
    logger = console.log,
  } = options;

  const state: ShutdownState = {
    isShuttingDown: false,
    signal: null,
  };

  async function shutdown(signal: string): Promise<void> {
    // Prevent double-shutdown
    if (state.isShuttingDown) {
      logger(`${signal} received again — shutdown already in progress`);
      return;
    }

    state.isShuttingDown = true;
    state.signal = signal;

    logger(`${signal} received — starting graceful shutdown`);

    if (onShutdownStart) {
      try {
        onShutdownStart(signal);
      } catch (err) {
        logger(`onShutdownStart error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Set a hard timeout to force exit if shutdown takes too long
    const forceExitTimer = setTimeout(() => {
      logger(`Shutdown timed out after ${timeout}ms — forcing exit`);
      process.exit(1);
    }, timeout);

    // Unref the timer so it doesn't keep the process alive
    if (forceExitTimer.unref) {
      forceExitTimer.unref();
    }

    // Step 1: Stop accepting new connections
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            // ENOTRUNNING means the server wasn't running — not a real error
            if ((err as any).code === "ERR_SERVER_NOT_RUNNING") {
              logger("HTTP server was not running");
              resolve();
            } else {
              reject(err);
            }
          } else {
            logger("HTTP server closed — no longer accepting connections");
            resolve();
          }
        });
      });
    } catch (err) {
      logger(`Error closing HTTP server: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 2: Close the PostgreSQL connection pool
    try {
      await pgPool.end();
      logger("PostgreSQL connection pool drained");
    } catch (err) {
      logger(`Error draining PostgreSQL pool: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Step 3: Close the OpenSearch client
    if (opensearchClient?.close) {
      try {
        await opensearchClient.close();
        logger("OpenSearch client closed");
      } catch (err) {
        logger(`Error closing OpenSearch client: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 4: Invoke completion callback
    if (onShutdownComplete) {
      try {
        onShutdownComplete();
      } catch (err) {
        logger(`onShutdownComplete error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    clearTimeout(forceExitTimer);
    logger("Graceful shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return state;
}

export default setupGracefulShutdown;

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/utils/gracefulShutdown.ts)
// ---------------------------------------------------------------------------

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  }

  console.log("Running gracefulShutdown self-tests...\n");

  // =========================================================================
  // 1. State initialization
  // =========================================================================
  console.log("=== 1. State initialization ===");
  {
    // Mock server, pool, and opensearch client
    const mockServer = {
      close: (cb?: (err?: Error) => void) => { if (cb) cb(); },
      on: () => {},
    } as unknown as Server;

    const mockPool = {
      end: async () => {},
    } as unknown as Pool;

    // We need to prevent process.exit from actually exiting during tests
    // So we capture the exit call instead
    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; }) as any;

    // Remove existing signal listeners to avoid interference
    const existingSIGTERM = process.listeners("SIGTERM");
    const existingSIGINT = process.listeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");

    const state = setupGracefulShutdown(mockServer, mockPool);

    assert(state.isShuttingDown === false, "isShuttingDown starts false");
    assert(state.signal === null, "signal starts null");

    // Clean up: restore original listeners and exit
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
    for (const listener of existingSIGTERM) process.on("SIGTERM", listener as any);
    for (const listener of existingSIGINT) process.on("SIGINT", listener as any);
    process.exit = originalExit;
  }

  // =========================================================================
  // 2. Callbacks are invoked
  // =========================================================================
  console.log("\n=== 2. Callbacks ===");
  {
    let shutdownStartCalled = false;
    let shutdownStartSignal = "";
    let completeCalled = false;
    const logs: string[] = [];

    const mockServer = {
      close: (cb?: (err?: Error) => void) => { if (cb) cb(); },
    } as unknown as Server;

    const mockPool = {
      end: async () => {},
    } as unknown as Pool;

    const mockOsClient = {
      close: async () => {},
    };

    const originalExit = process.exit;
    process.exit = (() => {}) as any;

    const existingSIGTERM = process.listeners("SIGTERM");
    const existingSIGINT = process.listeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");

    const state = setupGracefulShutdown(mockServer, mockPool, mockOsClient, {
      onShutdownStart: (signal) => {
        shutdownStartCalled = true;
        shutdownStartSignal = signal;
      },
      onShutdownComplete: () => {
        completeCalled = true;
      },
      logger: (msg) => logs.push(msg),
    });

    // Simulate SIGTERM by emitting it
    process.emit("SIGTERM", "SIGTERM");

    // Give async operations time to complete
    setTimeout(() => {
      assert(shutdownStartCalled, "onShutdownStart was called");
      assert(shutdownStartSignal === "SIGTERM", "signal is SIGTERM");
      assert(state.isShuttingDown === true, "isShuttingDown is true");
      assert(state.signal === "SIGTERM", "signal stored in state");
      assert(logs.some(l => l.includes("SIGTERM received")), "logged SIGTERM");
      assert(logs.some(l => l.includes("HTTP server closed")), "logged server closed");
      assert(logs.some(l => l.includes("PostgreSQL")), "logged pool drain");
      assert(logs.some(l => l.includes("OpenSearch")), "logged OS close");

      // Restore
      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      for (const listener of existingSIGTERM) process.on("SIGTERM", listener as any);
      for (const listener of existingSIGINT) process.on("SIGINT", listener as any);
      process.exit = originalExit;
    }, 100);
  }

  // =========================================================================
  // 3. Server close error handling
  // =========================================================================
  console.log("\n=== 3. Server close error ===");
  {
    const logs: string[] = [];

    const mockServer = {
      close: (cb?: (err?: Error) => void) => {
        if (cb) cb(new Error("Socket error"));
      },
    } as unknown as Server;

    const mockPool = {
      end: async () => {},
    } as unknown as Pool;

    const originalExit = process.exit;
    process.exit = (() => {}) as any;

    const existingSIGTERM = process.listeners("SIGTERM");
    const existingSIGINT = process.listeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");

    setupGracefulShutdown(mockServer, mockPool, undefined, {
      logger: (msg) => logs.push(msg),
    });

    process.emit("SIGTERM", "SIGTERM");

    setTimeout(() => {
      assert(
        logs.some(l => l.includes("Error closing HTTP server")),
        "logged server close error"
      );

      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      for (const listener of existingSIGTERM) process.on("SIGTERM", listener as any);
      for (const listener of existingSIGINT) process.on("SIGINT", listener as any);
      process.exit = originalExit;
    }, 100);
  }

  // =========================================================================
  // 4. Pool drain error handling
  // =========================================================================
  console.log("\n=== 4. Pool drain error ===");
  {
    const logs: string[] = [];

    const mockServer = {
      close: (cb?: (err?: Error) => void) => { if (cb) cb(); },
    } as unknown as Server;

    const mockPool = {
      end: async () => { throw new Error("Pool drain failed"); },
    } as unknown as Pool;

    const originalExit = process.exit;
    process.exit = (() => {}) as any;

    const existingSIGTERM = process.listeners("SIGTERM");
    const existingSIGINT = process.listeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");

    setupGracefulShutdown(mockServer, mockPool, undefined, {
      logger: (msg) => logs.push(msg),
    });

    process.emit("SIGTERM", "SIGTERM");

    setTimeout(() => {
      assert(
        logs.some(l => l.includes("Error draining PostgreSQL pool")),
        "logged pool drain error"
      );

      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      for (const listener of existingSIGTERM) process.on("SIGTERM", listener as any);
      for (const listener of existingSIGINT) process.on("SIGINT", listener as any);
      process.exit = originalExit;
    }, 100);
  }

  // =========================================================================
  // 5. No OpenSearch client (optional)
  // =========================================================================
  console.log("\n=== 5. No OpenSearch client ===");
  {
    const logs: string[] = [];

    const mockServer = {
      close: (cb?: (err?: Error) => void) => { if (cb) cb(); },
    } as unknown as Server;

    const mockPool = {
      end: async () => {},
    } as unknown as Pool;

    const originalExit = process.exit;
    process.exit = (() => {}) as any;

    const existingSIGTERM = process.listeners("SIGTERM");
    const existingSIGINT = process.listeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");

    setupGracefulShutdown(mockServer, mockPool, undefined, {
      logger: (msg) => logs.push(msg),
    });

    process.emit("SIGTERM", "SIGTERM");

    setTimeout(() => {
      assert(
        !logs.some(l => l.includes("OpenSearch")),
        "no OpenSearch log when client not provided"
      );
      assert(
        logs.some(l => l.includes("Graceful shutdown complete")),
        "shutdown completes without OS client"
      );

      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      for (const listener of existingSIGTERM) process.on("SIGTERM", listener as any);
      for (const listener of existingSIGINT) process.on("SIGINT", listener as any);
      process.exit = originalExit;
    }, 100);
  }

  // =========================================================================
  // 6. ERR_SERVER_NOT_RUNNING is handled gracefully
  // =========================================================================
  console.log("\n=== 6. ERR_SERVER_NOT_RUNNING ===");
  {
    const logs: string[] = [];

    const notRunningError = new Error("Server not running") as any;
    notRunningError.code = "ERR_SERVER_NOT_RUNNING";

    const mockServer = {
      close: (cb?: (err?: Error) => void) => { if (cb) cb(notRunningError); },
    } as unknown as Server;

    const mockPool = {
      end: async () => {},
    } as unknown as Pool;

    const originalExit = process.exit;
    process.exit = (() => {}) as any;

    const existingSIGTERM = process.listeners("SIGTERM");
    const existingSIGINT = process.listeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");

    setupGracefulShutdown(mockServer, mockPool, undefined, {
      logger: (msg) => logs.push(msg),
    });

    process.emit("SIGTERM", "SIGTERM");

    setTimeout(() => {
      assert(
        logs.some(l => l.includes("was not running")),
        "logged that server was not running"
      );
      assert(
        !logs.some(l => l.includes("Error closing HTTP server")),
        "did NOT log an error for ERR_SERVER_NOT_RUNNING"
      );

      process.removeAllListeners("SIGTERM");
      process.removeAllListeners("SIGINT");
      for (const listener of existingSIGTERM) process.on("SIGTERM", listener as any);
      for (const listener of existingSIGINT) process.on("SIGINT", listener as any);
      process.exit = originalExit;
    }, 100);
  }

  // Let async tests complete before printing summary
  setTimeout(() => {
    // Note: async test assertions are checked above in their timeouts.
    // The final count reflects synchronous assertions.
    console.log(`\n  ${passed} passed, ${failed} failed (sync tests)`);
    if (failed === 0) {
      console.log("\nAll gracefulShutdown sync tests passed");
      console.log("(async tests run in timeouts above — check for FAIL messages)");
    } else {
      process.exit(1);
    }
  }, 500);
}

if (require.main === module) {
  runSelfTests();
}
