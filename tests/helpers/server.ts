// ---------------------------------------------------------------------------
// Server Lifecycle — auto-start / stop for integration tests
//
// Manages a child-process server instance. If the server is already running
// externally, it reuses it. Otherwise it spawns one and waits for /health.
//
// Usage:
//   import { ensureServer, stopServer } from "../helpers/server";
//   await ensureServer();   // call once before tests
//   stopServer();           // call once after tests
// ---------------------------------------------------------------------------

import path from "path";
import { ChildProcess, spawn } from "child_process";
import { BASE_URL } from "./api";

let serverProcess: ChildProcess | null = null;

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function ensureServer(): Promise<void> {
  if (await isServerRunning()) {
    console.log("  Server already running, using existing instance.\n");
    return;
  }

  console.log("  Starting server...");
  const rootDir = path.resolve(__dirname, "../..");
  serverProcess = spawn("npx", ["tsx", "src/server.ts"], {
    cwd: rootDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const maxWait = 15_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    if (await isServerRunning()) {
      console.log("  Server is ready.\n");
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error("Server did not start within 15 seconds.");
}

export function stopServer(): void {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
}
