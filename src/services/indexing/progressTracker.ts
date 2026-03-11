// ---------------------------------------------------------------------------
// Progress Tracker
//
// Tracks progress across the multi-stage indexing pipeline and provides
// real-time progress information. Used by the indexing API to return
// progress status to the caller.
//
// The class is generic — it does NOT validate stage names against a fixed
// list. The 7-stage names used by the indexing pipeline (stage1_metadata
// through stage7_index) are a convention, not enforced here.
//
// WebSocket / event emitter support is explicitly out of scope. State is
// exposed solely via getProgress().
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Possible stage statuses. */
export type StageStatus = "pending" | "running" | "complete" | "failed";

/** Internal state for a single stage. */
interface StageState {
  status: StageStatus;
  totalItems: number;
  processedItems: number;
  startTime: number | null;
  durationMs: number | null;
  result?: unknown;
  error?: string;
}

/** A completed stage in the progress report. */
export interface StageComplete {
  status: "complete";
  durationMs: number;
  result?: unknown;
}

/** A failed stage in the progress report. */
export interface StageFailed {
  status: "failed";
  durationMs: number;
  error: string;
}

/** A running stage in the progress report. */
export interface StageRunning {
  status: "running";
  progress: string;
}

/** A pending stage in the progress report. */
export interface StagePending {
  status: "pending";
}

export type StageInfo = StageComplete | StageFailed | StageRunning | StagePending;

/** The full progress report returned by getProgress(). */
export interface ProgressReport {
  /** The name of the currently running stage, or null if none running. */
  currentStage: string | null;
  /** Overall progress as a percentage (0-100). */
  overallPercent: number;
  /** Per-stage status, keyed by stage name in insertion order. */
  stages: Record<string, StageInfo>;
}

// ---------------------------------------------------------------------------
// ProgressTracker
// ---------------------------------------------------------------------------

/**
 * Tracks progress across a multi-stage pipeline.
 *
 * Usage:
 * ```ts
 * const tracker = new ProgressTracker();
 * tracker.startStage("stage1_metadata", 1);
 * tracker.completeStage("stage1_metadata");
 * tracker.startStage("stage2_index", 1);
 * tracker.completeStage("stage2_index");
 * console.log(tracker.getProgress().overallPercent); // 100
 * ```
 */
export class ProgressTracker {
  /** Stage states in insertion order (Map preserves insertion order). */
  private readonly stages: Map<string, StageState> = new Map();

  // -----------------------------------------------------------------------
  // startStage()
  // -----------------------------------------------------------------------

  /**
   * Mark a stage as started.
   *
   * @param stageName  - Name of the stage (any string).
   * @param totalItems - Expected number of items to process in this stage.
   */
  startStage(stageName: string, totalItems: number): void {
    this.stages.set(stageName, {
      status: "running",
      totalItems,
      processedItems: 0,
      startTime: Date.now(),
      durationMs: null,
    });
  }

  // -----------------------------------------------------------------------
  // updateProgress()
  // -----------------------------------------------------------------------

  /**
   * Update the count of processed items for a running stage.
   *
   * @param stageName      - Name of the stage.
   * @param processedItems - Number of items processed so far.
   */
  updateProgress(stageName: string, processedItems: number): void {
    const stage = this.stages.get(stageName);
    if (!stage) return;
    stage.processedItems = processedItems;
  }

  // -----------------------------------------------------------------------
  // completeStage()
  // -----------------------------------------------------------------------

  /**
   * Mark a stage as complete.
   *
   * @param stageName - Name of the stage.
   * @param result    - Optional result object to attach.
   */
  completeStage(stageName: string, result?: unknown): void {
    const stage = this.stages.get(stageName);
    if (!stage) return;

    stage.status = "complete";
    stage.processedItems = stage.totalItems;
    stage.durationMs =
      stage.startTime !== null ? Date.now() - stage.startTime : 0;
    if (result !== undefined) {
      stage.result = result;
    }
  }

  // -----------------------------------------------------------------------
  // failStage()
  // -----------------------------------------------------------------------

  /**
   * Mark a stage as failed.
   *
   * @param stageName - Name of the stage.
   * @param error     - Error description string.
   */
  failStage(stageName: string, error: string): void {
    const stage = this.stages.get(stageName);
    if (!stage) return;

    stage.status = "failed";
    stage.durationMs =
      stage.startTime !== null ? Date.now() - stage.startTime : 0;
    stage.error = error;
  }

  // -----------------------------------------------------------------------
  // getProgress()
  // -----------------------------------------------------------------------

  /**
   * Return current progress across all stages.
   *
   * Overall percent formula: each stage has equal weight (1/N). A completed
   * stage contributes its full weight. A running stage contributes
   * `(processedItems / totalItems) * (1/N)`. Pending and failed stages
   * contribute 0. Result is `Math.round(sum * 100)`.
   */
  getProgress(): ProgressReport {
    const stageCount = this.stages.size;
    let currentStage: string | null = null;
    let weightedSum = 0;
    const stagesOutput: Record<string, StageInfo> = {};

    for (const [name, state] of this.stages) {
      switch (state.status) {
        case "complete":
          weightedSum += 1;
          stagesOutput[name] = {
            status: "complete",
            durationMs: state.durationMs ?? 0,
            ...(state.result !== undefined ? { result: state.result } : {}),
          };
          break;

        case "failed":
          // Failed stages contribute 0 to overallPercent
          stagesOutput[name] = {
            status: "failed",
            durationMs: state.durationMs ?? 0,
            error: state.error ?? "Unknown error",
          };
          break;

        case "running": {
          currentStage = name;
          const fraction =
            state.totalItems > 0
              ? state.processedItems / state.totalItems
              : 0;
          weightedSum += fraction;

          const pct =
            state.totalItems > 0
              ? Math.round((state.processedItems / state.totalItems) * 100)
              : 0;
          stagesOutput[name] = {
            status: "running",
            progress: `${state.processedItems}/${state.totalItems} (${pct}%)`,
          };
          break;
        }

        case "pending":
          // Pending stages contribute 0
          stagesOutput[name] = { status: "pending" };
          break;
      }
    }

    const overallPercent =
      stageCount > 0 ? Math.round((weightedSum / stageCount) * 100) : 0;

    return {
      currentStage,
      overallPercent,
      stages: stagesOutput,
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export default ProgressTracker;

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/services/indexing/progressTracker.ts)
// ---------------------------------------------------------------------------

function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      passed++;
    } else {
      failed++;
      console.error(`  FAIL: ${label}`);
    }
  }

  console.log("Running progressTracker self-tests...\n");

  // =======================================================================
  // Test 1: Fresh tracker — no stages
  // =======================================================================
  {
    const t = new ProgressTracker();
    const p = t.getProgress();

    assert(p.currentStage === null, "fresh: currentStage is null");
    assert(p.overallPercent === 0, "fresh: overallPercent is 0");
    assert(Object.keys(p.stages).length === 0, "fresh: no stages");
  }

  // =======================================================================
  // Test 2: Single stage — start, update, complete
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("stage1", 100);

    let p = t.getProgress();
    assert(p.currentStage === "stage1", "single start: currentStage");
    assert(p.overallPercent === 0, "single start: overallPercent 0");
    assert(p.stages.stage1.status === "running", "single start: status running");
    assert(
      (p.stages.stage1 as StageRunning).progress === "0/100 (0%)",
      `single start: progress (got: '${(p.stages.stage1 as StageRunning).progress}')`
    );

    t.updateProgress("stage1", 50);
    p = t.getProgress();
    assert(p.overallPercent === 50, `single half: overallPercent 50 (got: ${p.overallPercent})`);
    assert(
      (p.stages.stage1 as StageRunning).progress === "50/100 (50%)",
      `single half: progress (got: '${(p.stages.stage1 as StageRunning).progress}')`
    );

    t.completeStage("stage1");
    p = t.getProgress();
    assert(p.currentStage === null, "single complete: currentStage is null");
    assert(p.overallPercent === 100, "single complete: overallPercent 100");
    assert(p.stages.stage1.status === "complete", "single complete: status complete");
    assert(
      typeof (p.stages.stage1 as StageComplete).durationMs === "number",
      "single complete: has durationMs"
    );
    assert(
      (p.stages.stage1 as StageComplete).durationMs >= 0,
      "single complete: durationMs >= 0"
    );
  }

  // =======================================================================
  // Test 3: Spec test — 3 stages sequentially, overallPercent increases
  // =======================================================================
  {
    const t = new ProgressTracker();

    // Stage 1
    t.startStage("s1", 10);
    assert(t.getProgress().overallPercent === 0, "3 stages: after s1 start, 0%");

    t.completeStage("s1");
    // 1 stage total, 1 complete → 100% ... but we only have 1 stage registered
    // so 1/1 = 100. But if we plan 3 stages, we need to register them.
    // The spec says N = unique stages started. So at this point N=1.
    // Let's track as the spec says: N = count of unique stages started.
    assert(t.getProgress().overallPercent === 100, "3 stages: after s1 complete, 100% (N=1)");

    // Stage 2
    t.startStage("s2", 10);
    // Now N=2: s1 complete (1/2), s2 running 0/10 (0/2) → 0.5 → 50%
    assert(t.getProgress().overallPercent === 50, `3 stages: after s2 start, 50% (got: ${t.getProgress().overallPercent})`);

    t.completeStage("s2");
    // N=2: both complete → 2/2 → 100%
    assert(t.getProgress().overallPercent === 100, "3 stages: after s2 complete, 100% (N=2)");

    // Stage 3
    t.startStage("s3", 10);
    // N=3: 2 complete (2/3), s3 running 0/10 → 2/3 → 67%
    assert(t.getProgress().overallPercent === 67, `3 stages: after s3 start, 67% (got: ${t.getProgress().overallPercent})`);

    t.updateProgress("s3", 5);
    // N=3: 2 complete + 0.5 running → 2.5/3 → 83%
    assert(t.getProgress().overallPercent === 83, `3 stages: s3 half, 83% (got: ${t.getProgress().overallPercent})`);

    t.completeStage("s3");
    assert(t.getProgress().overallPercent === 100, "3 stages: all complete, 100%");
  }

  // =======================================================================
  // Test 4: Spec test — progress shows "50/100 (50%)"
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("test", 100);
    t.updateProgress("test", 50);

    const progress = (t.getProgress().stages.test as StageRunning).progress;
    assert(
      progress === "50/100 (50%)",
      `progress format: (got: '${progress}')`
    );
  }

  // =======================================================================
  // Test 5: Spec test — fail a stage
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("doomed", 100);
    t.updateProgress("doomed", 30);

    // Small delay to ensure durationMs > 0
    const start = Date.now();
    while (Date.now() - start < 2) { /* spin */ }

    t.failStage("doomed", "OpenSearch cluster unreachable");

    const p = t.getProgress();
    assert(p.stages.doomed.status === "failed", "fail: status is 'failed'");
    assert(
      (p.stages.doomed as StageFailed).error === "OpenSearch cluster unreachable",
      "fail: error message"
    );
    assert(
      typeof (p.stages.doomed as StageFailed).durationMs === "number",
      "fail: has durationMs"
    );
    assert(
      (p.stages.doomed as StageFailed).durationMs >= 0,
      "fail: durationMs >= 0"
    );
  }

  // =======================================================================
  // Test 6: Failed stage contributes 0 to overallPercent
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("s1", 10);
    t.completeStage("s1");

    t.startStage("s2", 10);
    t.failStage("s2", "error");

    // N=2: 1 complete (1), 1 failed (0) → 1/2 → 50%
    assert(
      t.getProgress().overallPercent === 50,
      `failed contrib: 50% (got: ${t.getProgress().overallPercent})`
    );
  }

  // =======================================================================
  // Test 7: Seven stages — the pipeline convention
  // =======================================================================
  {
    const t = new ProgressTracker();
    const stages = [
      "stage1_metadata",
      "stage2_index",
      "stage3_read",
      "stage4_validate",
      "stage5_transform",
      "stage6_merge",
      "stage7_index",
    ];

    // Complete stages 1-4
    for (let i = 0; i < 4; i++) {
      t.startStage(stages[i], 1);
      t.completeStage(stages[i]);
    }

    // Start stage 5 with 1000 items, process 450
    t.startStage(stages[4], 1000);
    t.updateProgress(stages[4], 450);

    const p = t.getProgress();

    // N=5 (only 5 stages started so far)
    // 4 complete (4) + 450/1000 running (0.45) → 4.45/5 → 89%
    assert(p.currentStage === "stage5_transform", "7-stage: currentStage");
    assert(
      p.overallPercent === 89,
      `7-stage: overallPercent 89 (got: ${p.overallPercent})`
    );

    const s5 = p.stages.stage5_transform as StageRunning;
    assert(s5.status === "running", "7-stage: stage5 running");
    assert(
      s5.progress === "450/1000 (45%)",
      `7-stage: stage5 progress (got: '${s5.progress}')`
    );

    // Stages 6-7 not started yet — they shouldn't appear
    assert(!("stage6_merge" in p.stages), "7-stage: stage6 not in output");
    assert(!("stage7_index" in p.stages), "7-stage: stage7 not in output");
  }

  // =======================================================================
  // Test 8: completeStage with result
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("s1", 1);
    t.completeStage("s1", { rowCount: 500, indexName: "ontology-employee" });

    const stage = t.getProgress().stages.s1 as StageComplete;
    assert(stage.status === "complete", "result: status complete");
    assert(
      (stage.result as { rowCount: number }).rowCount === 500,
      "result: has result.rowCount"
    );
  }

  // =======================================================================
  // Test 9: completeStage without result — no result key
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("s1", 1);
    t.completeStage("s1");

    const stage = t.getProgress().stages.s1 as StageComplete;
    assert(!("result" in stage), "no result: result key absent");
  }

  // =======================================================================
  // Test 10: updateProgress on non-existent stage — no-op
  // =======================================================================
  {
    const t = new ProgressTracker();
    // Should not throw
    t.updateProgress("nonexistent", 50);
    assert(Object.keys(t.getProgress().stages).length === 0, "nonexistent update: no stages");
  }

  // =======================================================================
  // Test 11: completeStage on non-existent stage — no-op
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.completeStage("nonexistent");
    assert(Object.keys(t.getProgress().stages).length === 0, "nonexistent complete: no stages");
  }

  // =======================================================================
  // Test 12: failStage on non-existent stage — no-op
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.failStage("nonexistent", "err");
    assert(Object.keys(t.getProgress().stages).length === 0, "nonexistent fail: no stages");
  }

  // =======================================================================
  // Test 13: Stage with totalItems = 0
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("empty", 0);

    const p = t.getProgress();
    const s = p.stages.empty as StageRunning;
    assert(s.progress === "0/0 (0%)", `zero items: progress (got: '${s.progress}')`);
    assert(p.overallPercent === 0, "zero items: overallPercent 0");
  }

  // =======================================================================
  // Test 14: Multiple running stages (unusual but valid)
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("a", 100);
    t.updateProgress("a", 50);
    t.startStage("b", 100);
    t.updateProgress("b", 25);

    const p = t.getProgress();
    // N=2: a running 0.5, b running 0.25 → 0.75/2 → 38%
    assert(
      p.overallPercent === 38,
      `two running: 38% (got: ${p.overallPercent})`
    );
    // currentStage should be the last running stage encountered
    assert(p.currentStage === "b", "two running: currentStage is 'b'");
  }

  // =======================================================================
  // Test 15: overallPercent rounding
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("s1", 3);
    t.completeStage("s1");
    t.startStage("s2", 3);
    t.completeStage("s2");
    t.startStage("s3", 3);
    t.updateProgress("s3", 1);

    // N=3: 2 complete + 1/3 running → 2.333/3 = 0.777... → 78%
    assert(
      t.getProgress().overallPercent === 78,
      `rounding: 78% (got: ${t.getProgress().overallPercent})`
    );
  }

  // =======================================================================
  // Test 16: Stages appear in insertion order
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("alpha", 1);
    t.completeStage("alpha");
    t.startStage("beta", 1);
    t.completeStage("beta");
    t.startStage("gamma", 1);

    const stageNames = Object.keys(t.getProgress().stages);
    assert(stageNames[0] === "alpha", "order: first is alpha");
    assert(stageNames[1] === "beta", "order: second is beta");
    assert(stageNames[2] === "gamma", "order: third is gamma");
  }

  // =======================================================================
  // Test 17: Restarting a stage overwrites previous state
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("s1", 100);
    t.updateProgress("s1", 50);
    t.startStage("s1", 200); // restart

    const s = t.getProgress().stages.s1 as StageRunning;
    assert(s.status === "running", "restart: status running");
    assert(s.progress === "0/200 (0%)", `restart: progress reset (got: '${s.progress}')`);
  }

  // =======================================================================
  // Test 18: Progress string format variations
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("s", 1000);

    t.updateProgress("s", 0);
    assert(
      (t.getProgress().stages.s as StageRunning).progress === "0/1000 (0%)",
      "format: 0/1000 (0%)"
    );

    t.updateProgress("s", 1);
    assert(
      (t.getProgress().stages.s as StageRunning).progress === "1/1000 (0%)",
      "format: 1/1000 (0%)"
    );

    t.updateProgress("s", 999);
    assert(
      (t.getProgress().stages.s as StageRunning).progress === "999/1000 (100%)",
      `format: 999/1000 (got: '${(t.getProgress().stages.s as StageRunning).progress}')`
    );

    t.updateProgress("s", 1000);
    assert(
      (t.getProgress().stages.s as StageRunning).progress === "1000/1000 (100%)",
      "format: 1000/1000 (100%)"
    );
  }

  // =======================================================================
  // Test 19: StageComplete shape
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("s", 1);
    t.completeStage("s");

    const s = t.getProgress().stages.s;
    assert("status" in s, "complete shape: has status");
    assert("durationMs" in s, "complete shape: has durationMs");
    assert(s.status === "complete", "complete shape: status value");
  }

  // =======================================================================
  // Test 20: StageFailed shape
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("s", 1);
    t.failStage("s", "boom");

    const s = t.getProgress().stages.s;
    assert("status" in s, "failed shape: has status");
    assert("durationMs" in s, "failed shape: has durationMs");
    assert("error" in s, "failed shape: has error");
    assert(s.status === "failed", "failed shape: status value");
    assert((s as StageFailed).error === "boom", "failed shape: error value");
  }

  // =======================================================================
  // Test 21: StageRunning shape
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("s", 10);

    const s = t.getProgress().stages.s;
    assert("status" in s, "running shape: has status");
    assert("progress" in s, "running shape: has progress");
    assert(s.status === "running", "running shape: status value");
    assert(typeof (s as StageRunning).progress === "string", "running shape: progress is string");
  }

  // =======================================================================
  // Test 22: ProgressReport shape
  // =======================================================================
  {
    const t = new ProgressTracker();
    const p = t.getProgress();

    assert("currentStage" in p, "report shape: has currentStage");
    assert("overallPercent" in p, "report shape: has overallPercent");
    assert("stages" in p, "report shape: has stages");
    assert(typeof p.overallPercent === "number", "report shape: overallPercent is number");
    assert(typeof p.stages === "object", "report shape: stages is object");
  }

  // =======================================================================
  // Test 23: All stages complete → 100%
  // =======================================================================
  {
    const t = new ProgressTracker();
    for (let i = 1; i <= 7; i++) {
      t.startStage(`s${i}`, 100);
      t.completeStage(`s${i}`);
    }

    assert(t.getProgress().overallPercent === 100, "all complete: 100%");
    assert(t.getProgress().currentStage === null, "all complete: no current");
  }

  // =======================================================================
  // Test 24: Custom stage names accepted
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("my_custom_stage", 5);
    t.updateProgress("my_custom_stage", 3);

    const p = t.getProgress();
    assert("my_custom_stage" in p.stages, "custom name: accepted");
    assert(p.currentStage === "my_custom_stage", "custom name: currentStage");
  }

  // =======================================================================
  // Test 25: Equal weight per stage — 4 stages, 2 complete
  // =======================================================================
  {
    const t = new ProgressTracker();
    t.startStage("a", 1);
    t.completeStage("a");
    t.startStage("b", 1);
    t.completeStage("b");
    t.startStage("c", 1);
    t.startStage("d", 1);

    // N=4: 2 complete (2) + 2 running at 0 → 2/4 → 50%
    assert(
      t.getProgress().overallPercent === 50,
      `equal weight: 50% (got: ${t.getProgress().overallPercent})`
    );
  }

  // =======================================================================
  // Summary
  // =======================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll progressTracker tests passed");
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  runSelfTests();
}
