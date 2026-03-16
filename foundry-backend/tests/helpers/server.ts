import { ChildProcess, spawn } from 'child_process';
import path from 'path';

let serverProcess: ChildProcess | null = null;
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001';

export async function ensureServer(): Promise<void> {
  // Check if already running
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (res.ok) return;
  } catch { /* not running */ }

  // Start the server
  const projectRoot = path.resolve(__dirname, '../..');
  serverProcess = spawn('npx', ['ts-node-dev', '--transpile-only', '-r', 'tsconfig-paths/register', 'src/index.ts'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: '3001', NODE_ENV: 'test' },
    stdio: 'pipe',
  });

  // Wait for server to be ready (max 15s)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
  }
  throw new Error('Server failed to start within 15 seconds');
}

export function stopServer(): void {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}
