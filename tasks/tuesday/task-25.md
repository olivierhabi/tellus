# TASK 25: Create the Progress Tracker

**File to create:** `/src/services/indexing/progressTracker.js`

**Purpose:** Tracks progress across the 7-stage indexing pipeline and provides real-time progress updates. Used by the indexing API to return progress information.

**Specification:**

Create a class `ProgressTracker` with:

- **`startStage(stageName, totalItems)`** — Marks a stage as started. Records `Date.now()` as the stage start time internally. `totalItems` is the expected number of items to process in this stage (e.g., 1000 rows). Sets the stage status to `"running"`.

- **`updateProgress(stageName, processedItems)`** — Updates the count of processed items for a running stage.

- **`completeStage(stageName, result)`** — Marks a stage as complete with an optional result object. Computes `durationMs = Date.now() - startTime`. Sets status to `"complete"`.

- **`failStage(stageName, error)`** — Marks a stage as failed with the error. Computes `durationMs = Date.now() - startTime`. Sets status to `"failed"`.

- **`getProgress()`** — Returns current progress across all stages:
  ```javascript
  {
    currentStage: "stage5_transform",
    overallPercent: 65,
    stages: {
      stage1_metadata: { status: "complete", durationMs: 15 },
      stage2_index: { status: "complete", durationMs: 200 },
      stage3_read: { status: "complete", durationMs: 45 },
      stage4_validate: { status: "complete", durationMs: 12 },
      stage5_transform: { status: "running", progress: "450/1000 (45%)" },
      stage6_merge: { status: "pending" },
      stage7_index: { status: "pending" }
    }
  }
  ```

**Overall percent formula:** `overallPercent` is calculated as follows: each stage has equal weight (1/N of the total, where N is the number of registered stages). A completed stage contributes its full weight. A running stage contributes `(processedItems / totalItems) * (1/N)`. Pending and failed stages contribute 0. The result is `Math.round(sum * 100)`.

**Stage name validation:** The class does NOT validate stage names against a fixed list. It is generic and accepts any string as `stageName`. The 7-stage names shown in the example (`stage1_metadata` through `stage7_index`) are the convention used by the indexing pipeline but are not enforced by this class. The total number of stages (N) is determined by the number of unique stages that have been started via `startStage`.

**WebSocket:** WebSocket support is explicitly OUT OF SCOPE for this task. The class exposes state via `getProgress()` only. No event emitters, no callbacks on state change.

**Test to verify:** Create a tracker, start 3 stages sequentially, verify `overallPercent` increases correctly. Start a stage with 100 items, update to 50, verify progress shows "50/100 (50%)". Fail a stage, verify status is `"failed"` with `durationMs` set.
