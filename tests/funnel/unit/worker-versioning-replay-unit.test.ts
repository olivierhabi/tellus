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

import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { Worker } from "@temporalio/worker";

const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/histories");

function fixtureFiles(): string[] {
  if (!fs.existsSync(FIXTURE_DIR)) return [];
  return fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
}

describe("workflow replay gate", () => {
  it("captured production-like histories replay deterministically", async () => {
    const files = fixtureFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const history = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"));
      await Worker.runReplayHistory(
        {
          workflowsPath: path.resolve(
            FIXTURE_DIR,
            file.includes("funnel")
              ? "../../../../src/services/funnel/temporal/workflowsBundle.ts"
              : "../../../../scripts/temporal-probe/workflowBundle.ts",
          ),
        } as never,
        history,
      );
    }
  }, 180_000);
});
