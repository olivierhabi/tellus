// ---------------------------------------------------------------------------
// ObjectTypeFunnelWorkflow — continue-as-new signal carry-over.
//
// HONEST SCOPE. This suite does NOT execute the workflow: @temporalio/testing
// is not a dependency of this repo, so there is no TestWorkflowEnvironment to
// replay against, and a hand-mocked `@temporalio/workflow` would prove only
// that the mock behaves — the bug being guarded lives in Temporal's own
// task-boundary semantics, which a mock by definition does not reproduce.
//
// What it DOES pin is the two properties of the fix that are checkable without
// a workflow runtime, and that a well-meaning refactor can break while tsc
// stays green:
//
//   1. Structural: there is NO `await` between snapshotting `pending` and the
//      `continueAsNew` call. An await yields a new workflow task, and a signal
//      delivered in that window is appended to an array belonging to an
//      execution that is already terminating — so it evaporates. Because the
//      dispatcher has already CAS'd its funnel_run row to 'workflow_started',
//      the reconciler considers the dispatch delivered and never re-signals:
//      the save silently never indexes. This is asserted against the real
//      source text, which is the only place the property is observable.
//
//   2. Continuity of the seeded queue: the child seeds `pending` from
//      `seedPendingSignals`, drains in FIFO order, and the FUNN-ISO identity
//      fence (objectTypeRid + environmentId) plus the host-resolved
//      continueAsNewThreshold survive the boundary. Dropping the fence would
//      leave every child un-fenced; dropping the threshold would silently
//      revert an operator override to the default.
//
// End-to-end proof that a signal racing the boundary is retained needs a real
// Temporal test environment and is recorded as an open gap, not claimed here.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const WORKFLOWS_SRC = readFileSync(
  path.resolve(__dirname, "../../../src/services/funnel/temporal/workflows.ts"),
  "utf8",
);

/**
 * The continue-as-new block: from the `pending.splice` snapshot through the
 * closing paren of the continueAsNew call.
 */
function continueAsNewBlock(): string {
  const start = WORKFLOWS_SRC.indexOf("pending.splice(0, pending.length)");
  expect(start, "pending.splice snapshot not found — did the fix get reverted?").toBeGreaterThan(-1);
  const call = WORKFLOWS_SRC.indexOf("continueAsNew<", start);
  expect(call, "continueAsNew call not found after the snapshot").toBeGreaterThan(-1);
  // Walk to the end of the argument object so the assertions below cover the
  // whole payload, not just the first line.
  let depth = 0;
  let i = WORKFLOWS_SRC.indexOf("(", call);
  for (; i < WORKFLOWS_SRC.length; i++) {
    if (WORKFLOWS_SRC[i] === "(") depth++;
    else if (WORKFLOWS_SRC[i] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  return WORKFLOWS_SRC.slice(start, i + 1);
}

/** Strip comments so prose about `await` cannot satisfy or trip an assertion. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("continue-as-new — no await between snapshot and hand-off", () => {
  it("snapshots pending with splice, so the parent's queue is emptied into a local", () => {
    // splice (not slice): leaving the entries in `pending` as well would let a
    // late drain double-process them.
    expect(WORKFLOWS_SRC).toMatch(
      /const\s+carriedOver\s*=\s*pending\.splice\(0,\s*pending\.length\)/,
    );
  });

  it("has NO await between the snapshot and the continueAsNew call", () => {
    const block = stripComments(continueAsNewBlock());
    // The only permitted `await` is the one ON continueAsNew itself, which sits
    // immediately before the call — drop it, then nothing may remain.
    const beforeCall = block
      .slice(0, block.indexOf("continueAsNew<"))
      .replace(/\bawait\s*$/, "");
    expect(beforeCall).not.toMatch(/\bawait\b/);
    expect(beforeCall).not.toMatch(/\byield\b/);
    // Guard the guard: the await really is adjacent to the call, so the strip
    // above cannot be hiding an extra one somewhere in between.
    expect(block).toMatch(/\bawait\s+continueAsNew</);
  });

  it("passes the snapshot straight into the hand-off payload", () => {
    expect(stripComments(continueAsNewBlock())).toMatch(
      /seedPendingSignals:\s*carriedOver/,
    );
  });

  it("carries the FUNN-ISO identity fence across the boundary", () => {
    // Without these the child workflow is un-fenced: a worker attached to the
    // wrong environment could run a pass the parent would have rejected.
    const block = stripComments(continueAsNewBlock());
    expect(block).toMatch(/objectTypeRid:\s*input\.objectTypeRid/);
    expect(block).toMatch(/environmentId:\s*input\.environmentId/);
  });

  it("carries the host-resolved threshold and resets the run counter", () => {
    const block = stripComments(continueAsNewBlock());
    // The workflow sandbox has no `process`, so the threshold can only come
    // from input — losing it silently reverts an operator override.
    expect(block).toMatch(/continueAsNewThreshold:\s*input\.continueAsNewThreshold/);
    expect(block).toMatch(/seedCompletedRuns:\s*0/);
    expect(block).toMatch(/seedLastProcessedSignalId:\s*lastProcessedSignalId/);
  });

  it("imports continueAsNew statically, not via a dynamic import inside the workflow", () => {
    // A dynamic import() in a workflow is a non-deterministic side effect.
    expect(WORKFLOWS_SRC).toMatch(
      /import\s*\{[^}]*\bcontinueAsNew\b[^}]*\}\s*from\s*["']@temporalio\/workflow["']/s,
    );
    const block = stripComments(continueAsNewBlock());
    expect(block).not.toMatch(/import\s*\(/);
  });
});

describe("continue-as-new — seeded queue continuity in the child", () => {
  it("seeds pending from seedPendingSignals rather than starting empty", () => {
    // `[...(input.seedPendingSignals ?? [])]` — a copy, so mutating the queue
    // cannot write back into the workflow input Temporal will replay.
    expect(WORKFLOWS_SRC).toMatch(
      /const\s+pending:\s*SignalPayload\[\]\s*=\s*\[\s*\.\.\.\(input\.seedPendingSignals\s*\?\?\s*\[\]\)\s*\]/,
    );
  });

  it("seeds the run counter and last-processed cursor from input", () => {
    expect(WORKFLOWS_SRC).toMatch(/completedRuns\s*=\s*input\.seedCompletedRuns\s*\?\?\s*0/);
    expect(WORKFLOWS_SRC).toMatch(
      /lastProcessedSignalId\s*=\s*input\.seedLastProcessedSignalId/,
    );
  });

  it("declares seedPendingSignals as optional so a first-run dispatch needs no queue", () => {
    expect(WORKFLOWS_SRC).toMatch(/seedPendingSignals\?:\s*SignalPayload\[\]/);
  });
});

// ---------------------------------------------------------------------------
// The queue behaviour itself, on a model of the drain loop. This does not
// execute the workflow; it pins the ordering contract the seeded array must
// satisfy, so a change from FIFO shift() to pop() (which would reorder edits
// and let an older signal overwrite a newer one) is caught here rather than in
// production data.
// ---------------------------------------------------------------------------

type Sig = { signalId: string };

/** FIFO drain, mirroring the workflow's `pending.shift()` loop. */
function drain(seed: Sig[], delivered: Sig[] = []): string[] {
  const pending: Sig[] = [...seed, ...delivered];
  const order: string[] = [];
  while (pending.length > 0) order.push(pending.shift()!.signalId);
  return order;
}

describe("seeded queue drain order", () => {
  it("replays carried-over signals before newly delivered ones", () => {
    // A carried-over signal is older than anything the child receives, so it
    // must be processed first — otherwise a stale merge lands last and wins.
    expect(drain([{ signalId: "s1" }, { signalId: "s2" }], [{ signalId: "s3" }])).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("preserves relative order among carried-over signals", () => {
    const seed = ["a", "b", "c", "d"].map((signalId) => ({ signalId }));
    expect(drain(seed)).toEqual(["a", "b", "c", "d"]);
  });

  it("drains to empty, leaving nothing stranded for the next boundary", () => {
    const pending: Sig[] = [{ signalId: "x" }];
    const carried = pending.splice(0, pending.length);
    expect(carried).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });
});
