// ---------------------------------------------------------------------------
// Unit tests for Gap 2 (durable/resumable scheduling): retryBuild decision
// logic + crash-sweeper SQL narrowing. Mocked pool — no DB, no python spawn.
//
// retryBuild's decision path SHORT-CIRCUITS before prepareBuild (which does
// the preflight + read + spawn) for every rejection case, so these tests mock
// only the pool.query that looks up the original build row and assert the
// exact rejection returned — without ever starting a real build.
//
// Run: pnpm vitest run --config vitest.unit.config.ts tests/unit/code-repos/code-repository/transforms/transforms-retry-unit.test.ts
// ---------------------------------------------------------------------------
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the db module (pool.query) BEFORE importing buildService/crashSweeper.
vi.mock("../../../../../src/db", () => ({
  pool: { query: vi.fn() },
  getClient: vi.fn(),
}));
// Mock scanFile so any incidental datasetStore path doesn't touch the FS.
vi.mock("../../../../../src/services/fileScannerService", () => ({
  scanFile: vi.fn(),
}));

import { retryBuild } from "../../../../../src/services/codeRepository/transforms/buildService";
import { sweepStaleTransformBuilds } from "../../../../../src/services/codeRepository/transforms/crashSweeper";
import { pool } from "../../../../../src/db";

const q = pool.query as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const REPO = "ri.transform.main.repository.aaa";
const BUILD = "ri.transform.main.build.bbb";

// ===========================================================================
// retryBuild — the four rejection/replay decisions (all short-circuit before
// prepareBuild, so no preflight, no spawn, no repo read).
// ===========================================================================
describe("retryBuild — decision logic (Gap 2)", () => {
  it("returns BuildNotFound (404) when the original build does not exist", async () => {
    q.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // orig lookup
    const r = await retryBuild({ stemma: {} as never }, {
      repositoryRid: REPO, buildId: BUILD, actor: "u",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.status).toBe(404);
      expect(r.error.envelope.errorName).toBe("Transform:BuildNotFound");
    }
    // Only ONE query was issued (the lookup) — no idempotency probe, no prepareBuild.
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("returns BuildConflict (409) when the original is still in-flight (queued/running)", async () => {
    q.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ repository_rid: REPO, branch: "master", status: "running", retry_count: 0, max_retries: 3 }],
    });
    const r = await retryBuild({ stemma: {} as never }, {
      repositoryRid: REPO, buildId: BUILD, actor: "u",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.status).toBe(409);
      expect(r.error.envelope.errorName).toBe("Transform:BuildConflict");
    }
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("returns TooManyRetries (429) when retry_count >= max_retries (the cap is enforced)", async () => {
    q.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ repository_rid: REPO, branch: "master", status: "failed", retry_count: 3, max_retries: 3 }],
    });
    const r = await retryBuild({ stemma: {} as never }, {
      repositoryRid: REPO, buildId: BUILD, actor: "u",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.status).toBe(429);
      expect(r.error.envelope.errorName).toBe("Transform:TooManyRetries");
    }
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("idempotency replay: same Idempotency-Key returns the EXISTING build (200, no duplicate, no retry_count increment)", async () => {
    // First call: orig lookup -> a retryable failed build (retry_count 0 < max 3).
    q.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ repository_rid: REPO, branch: "master", status: "failed", retry_count: 0, max_retries: 3 }],
    });
    // Second call: idempotency probe finds an existing build for that key.
    q.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ rid: "ri.transform.main.build.existing", status: "succeeded", transform_count: 1 }],
    });
    const r = await retryBuild({ stemma: {} as never }, {
      repositoryRid: REPO, buildId: BUILD, actor: "u", idempotencyKey: "key-abc",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.buildRid).toBe("ri.transform.main.build.existing");
      expect(r.value.replayed).toBe(true);
    }
    // Exactly TWO queries: orig lookup + idempotency probe. prepareBuild was
    // NOT called (no preflight, no insert, no runBuild).
    expect(q).toHaveBeenCalledTimes(2);
  });

  // The retryable path (failed build under the cap proceeds to prepareBuild
  // and runs) is proven end-to-end by the cypress spec
  // transforms-retry.cy.ts (retry-succeeds-after-fix), not here — prepareBuild
  // does a real preflight + repo read + spawn, which is an E2E concern.
});

// ===========================================================================
// crashSweeper — Gap 2 SQL narrowing: 'running' -> failed, 'queued' LEFT
// ALONE (so requeueQueuedBuilds can recover it). The previous behavior failed
// BOTH ('queued','running'), which abandoned builds that had never started.
// ===========================================================================
describe("sweepStaleTransformBuilds — SQL narrows to 'running' only (Gap 2)", () => {
  it("issues an UPDATE whose WHERE clause targets status='running' (NOT 'queued')", async () => {
    q.mockResolvedValueOnce({ rowCount: 0 });
    await sweepStaleTransformBuilds();
    const sql = (q.mock.calls[0] as unknown[])[0] as string;
    expect(sql).toMatch(/status\s*=\s*'running'/i);
    // The old behavior (IN ('queued','running')) would have abandoned queued
    // builds. Assert 'queued' is NOT in the sweep WHERE.
    expect(sql).not.toMatch(/queued/i);
  });
});
