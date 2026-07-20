// ---------------------------------------------------------------------------
// Server-side preview cancellation — regression tests.
//
// These prove the OS-level process is ACTUALLY killed on Stop (not just that
// the runChild promise rejected) by polling pgrep for the spawned process:
//   (a)   aborting an in-flight run kills the OS process.
//   (group) aborting kills a forked child too (process-group kill — the
//          Spark-JVM scenario; a plain child.kill() would orphan it).
//   (b)   rapid Run→Stop→Run doesn't leak the prior process or cross-abort.
//   (c)   aborting AFTER the run already finished is a safe no-op.
//
// Gated on a usable python3 (runChild spawns resolveTransformPython()). The
// container path (runChildContainer → docker kill) is # UNVERIFIED here — it
// needs docker + the transform-runtime image; the kill mechanism is the same
// pattern (SIGTERM → 5s → SIGKILL on the cgroup).
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

import { runChild, pythonAvailable } from "../../../../../src/services/codeRepository/transforms/executor";

const HAS_PY = pythonAvailable().ok;
const describeOrSkip = HAS_PY ? describe : describe.skip;

// pgrep -f <pattern>: exit 0 = a match is alive, non-zero = no match (dead).
function isAlive(pattern: string): boolean {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  return r.status === 0;
}

async function waitForAlive(pattern: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAlive(pattern)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function waitForDead(pattern: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pattern)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function cleanupProc(pattern: string): void {
  try { spawnSync("pkill", ["-f", pattern], { encoding: "utf8" }); } catch { /* best-effort */ }
}

describeOrSkip("runChild cancel (server-side Stop)", () => {
  it("(a) aborting an in-flight run actually kills the OS process (pgrep, not just the promise)", async () => {
    const marker = `tellus-cancel-a-${Date.now()}-${process.pid}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-a-"));
    const script = path.join(dir, `${marker}.py`);
    fs.writeFileSync(script, "import time\ntime.sleep(120)\n");
    const controller = new AbortController();
    const p = runChild(script, dir, "{}", 60_000, [], controller.signal);
    try {
      expect(await waitForAlive(marker)).toBe(true); // spawned + sleeping
      controller.abort(); // FE Stop / connection close
      await p; // resolves after the kill
      expect(await waitForDead(marker)).toBe(true); // process is GONE
    } finally {
      cleanupProc(marker);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 30_000);

  it("(group-kill) aborting kills a forked child too (the Spark-JVM scenario)", async () => {
    // The driver forks a python child (mimics the Spark JVM fork). detached +
    // process.kill(-pid) must reach the child; a plain child.kill() would orphan
    // it. Verify BOTH the driver + the forked child are gone after abort.
    const marker = `tellus-cancel-g-${Date.now()}-${process.pid}`;
    const childMarker = `tellus-cancel-gc-${Date.now()}-${process.pid}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-g-"));
    const script = path.join(dir, `${marker}.py`);
    // Fork a child whose cmdline carries childMarker so pgrep -f can target it.
    fs.writeFileSync(
      script,
      `import subprocess, sys, time\nsubprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)  # ${childMarker}"])\ntime.sleep(120)\n`,
    );
    const controller = new AbortController();
    const p = runChild(script, dir, "{}", 60_000, [], controller.signal);
    try {
      expect(await waitForAlive(marker)).toBe(true); // driver alive
      expect(await waitForAlive(childMarker)).toBe(true); // forked child alive
      controller.abort(); // group-kill (SIGTERM → 5s → SIGKILL on -pid)
      await p;
      expect(await waitForDead(marker)).toBe(true); // driver gone
      expect(await waitForDead(childMarker)).toBe(true); // forked child GONE (group-kill reached it)
    } finally {
      cleanupProc(marker);
      cleanupProc(childMarker);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 30_000);

  it("(b) rapid Run→Stop→Run doesn't leak the prior process or cross-abort", async () => {
    const marker1 = `tellus-cancel-b1-${Date.now()}-${process.pid}`;
    const marker2 = `tellus-cancel-b2-${Date.now()}-${process.pid}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-b-"));
    const s1 = path.join(dir, `${marker1}.py`);
    const s2 = path.join(dir, `${marker2}.py`);
    fs.writeFileSync(s1, "import time\ntime.sleep(120)\n");
    fs.writeFileSync(s2, "import time\ntime.sleep(120)\n");
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = runChild(s1, dir, "{}", 60_000, [], c1.signal);
    try {
      expect(await waitForAlive(marker1)).toBe(true);
      c1.abort(); // Stop #1
      // Immediately kick run #2 + Stop it — the second AbortController must be
      // independent of the first (no double-track, no shared state).
      const p2 = runChild(s2, dir, "{}", 60_000, [], c2.signal);
      expect(await waitForAlive(marker2)).toBe(true);
      c2.abort(); // Stop #2
      await Promise.all([p1.catch(() => {}), p2.catch(() => {})]);
      // Both processes gone — no leak, no survivor.
      expect(await waitForDead(marker1)).toBe(true);
      expect(await waitForDead(marker2)).toBe(true);
    } finally {
      cleanupProc(marker1);
      cleanupProc(marker2);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 30_000);

  it("(c) aborting AFTER the run already finished is a safe no-op", async () => {
    const marker = `tellus-cancel-c-${Date.now()}-${process.pid}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cancel-c-"));
    const script = path.join(dir, `${marker}.py`);
    fs.writeFileSync(script, "import time\ntime.sleep(1)\n"); // finishes fast
    const controller = new AbortController();
    const p = runChild(script, dir, "{}", 60_000, [], controller.signal);
    try {
      await p; // the run finishes normally (process exits)
      expect(await waitForDead(marker)).toBe(true); // already gone
      // Aborting after completion: the close handler already removed the abort
      // listener + the PID is dead — must not throw + must be a no-op.
      expect(() => controller.abort()).not.toThrow();
    } finally {
      cleanupProc(marker);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }, 20_000);
});
