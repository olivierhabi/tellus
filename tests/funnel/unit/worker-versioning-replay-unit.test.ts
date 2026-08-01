// ---------------------------------------------------------------------------
// Workflow replay gate (FUNN-ISO-3): every captured production-like history
// under tests/funnel/fixtures/histories/ MUST replay deterministically under
// the CURRENT workflow binaries. A failure here means the deployed workflow
// code is NOT replay-safe — the exact class of breakage Worker Versioning
// protects in-flight histories from.
//
// Runs OFFLINE (no Temporal server): runReplayHistory spins a local replay
// worker in-process; the "fake" history files include the versioning-probe
// captures (scripts/temporal-probe/run-versioning-probe.ts) and, once
// captured, real funnel workflow histories from the fixture recovery run.
// ---------------------------------------------------------------------------

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/histories");

function fixtureFiles(): string[] {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
}

describe("workflow replay gate", () => {
  it("captured production-like histories replay deterministically", async () => {
    const files = fixtureFiles();
    expect(files.length).toBeGreaterThan(0);
    // The Temporal bridge owns a process-global native Runtime. Other unit
    // files can load/unload native modules before this test and leave bridge
    // handles from a different module instance, producing a Neon downcast
    // failure unrelated to replay determinism. Run the replay gate in one
    // clean child process so every history shares exactly one native Runtime.
    for (const file of files) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve(__dirname, "../../../scripts/replay-funnel-histories.ts"),
          path.join(FIXTURE_DIR, file),
        ],
        { cwd: path.resolve(__dirname, "../../.."), encoding: "utf8", timeout: 175_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain(`replayed ${file}`);
    }
  }, 180_000);
});
