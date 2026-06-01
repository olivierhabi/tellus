/**
 * B10 — OSDK regeneration hook.
 * On binding create/update, kicks the OSDK generator to emit a new typed
 * client version. The actual generator is a separate command in the repo;
 * this module enqueues a regeneration job and updates `osdk_version` once
 * the generator reports success.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";

export type RegenResult = { osdk_version: string; durationMs: number };

export interface RegenQueue {
  enqueue(args: { binding_rid: string; reason: string }): Promise<string>; // job id
}

let _queue: RegenQueue | null = null;
export function setRegenQueue(q: RegenQueue | null) {
  _queue = q;
}

/** In-process regen used in dev/tests; spawns the OSDK CLI if present. */
export async function regenInProc(bindingRid: string): Promise<RegenResult> {
  const start = Date.now();
  const cliPath = process.env.OSDK_CLI ?? path.resolve(process.cwd(), "scripts/osdk-regen.ts");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--enable-source-maps",
      "-r", "ts-node/register",
      cliPath,
      "--binding", bindingRid,
    ], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => reject(err));
    child.on("exit", (code) => {
      if (code === 0) {
        const versionTag = `osdk-${bindingRid.slice(-8)}-${Date.now()}`;
        resolve({ osdk_version: versionTag, durationMs: Date.now() - start });
      } else {
        reject(new Error(`osdk regen exited ${code}: ${stderr}`));
      }
    });
  });
}

export async function triggerRegen(bindingRid: string, reason: string): Promise<string | null> {
  if (_queue) return _queue.enqueue({ binding_rid: bindingRid, reason });
  return null;
}
