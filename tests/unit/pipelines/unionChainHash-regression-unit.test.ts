// ---------------------------------------------------------------------------
// Regression: PREVIEW_STALE on union nodes (deploy blocked with no API recourse)
//
// Two defects, both in the union path, fixed together because either one alone
// leaves the node un-deployable or the gate blind:
//
//   1. unionApply pinned `chainHash: hashTransformChain([])` — a hardcoded hash
//      of an EMPTY transform chain. unionApply is not the last writer of a
//      node's transforms (a DropDuplicates / Case / Select can be appended
//      afterwards), so the live chain hash immediately diverged and every
//      deploy failed 409 PREVIEW_STALE. No API could reconcile it: union
//      preview has no `persist`, and re-applying the union rewrote the same
//      empty hash.
//
//   2. chainHashFromNodeConfig hashed ONLY config.transforms. A union's second
//      input and column-merge policy live at config.rightNodeId /
//      config.rightNodeIds / config.mode, so swapping a union input or
//      flipping strict->wide did not change the hash AT ALL — the gate was
//      blind to exactly the drift it exists to catch.
//
// The invariant under test: every snapshot WRITER derives chainHash from the
// live node config via chainHashFromNodeConfig, so it always equals what the
// deploy gate recomputes.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { unionApply } from "../../../src/services/pipelines/ops/unionOps";
import { collectPreviewPinning } from "../../../src/services/deploy/previewPinning";
import {
  chainHashFromNodeConfig,
  hashTransformChain,
} from "../../../src/services/pipelines/previewSnapshot";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: null, sourceColumns: [], existingTransforms: [], baseRows: [],
    }),
    applyExistingTransforms: (rows) => rows,
    applyExistingTransformColumns: (cols) => cols,
    fetchNodeConfig: async (_p, _pl, nodeId) => ({
      id: nodeId, config: { sourceNodeId: "left", transforms: [] },
    }),
    saveNodeConfig: async (_n, _p, config) => ({ id: "u1", config }),
    assertColumnsExist: () => {},
    resolveNodeData: async () => ({ columns: [{ name: "account_id", type: "string" }], rows: [] }),
    persistExecutionSnapshot: async () => {},
    walkTransitiveInputs: async () => [],
    unionPreview: async () => ({
      columns: [{ name: "account_id", type: "string" }], rows: [{ account_id: "C1" }],
    }),
    ...overrides,
  };
}

async function applyUnion(
  initialConfig: Record<string, unknown>,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let saved: Record<string, unknown> = {};
  const ctx = stubCtx({
    fetchNodeConfig: async (_p, _pl, nodeId) => ({ id: nodeId, config: { ...initialConfig } }),
    saveNodeConfig: async (_n, _p, config) => { saved = config; return { id: "u1" }; },
  });
  await unionApply(ctx as unknown as Parameters<typeof unionApply>[0], "p", "pl", "u1", input);
  return saved;
}

describe("regression: union snapshot chain hash (PREVIEW_STALE)", () => {
  it("pins the node's REAL chain when the union is applied to a node that already has transforms", async () => {
    // unionApply is not the last writer of a node's transforms — apply
    // appends, so a node can legitimately carry a chain when the union lands.
    const saved = await applyUnion(
      { sourceNodeId: "left", transforms: [{ function: "DropDuplicates", columns: ["account_id"] }] },
      { rightNodeIds: ["right"], mode: "strict" },
    );
    const snap = saved.previewSnapshot as { chainHash: string };
    expect(snap.chainHash).toBe(chainHashFromNodeConfig(saved));
    expect(snap.chainHash).not.toBe(hashTransformChain([]));
    await expect(
      collectPreviewPinning("pl", [{ id: "u1", config: saved }],
        { force: false, ignorePreviewSnapshot: false }),
    ).resolves.toMatchObject({ staleNodeIds: [] });
  });

  it("re-applying the union reconciles a node whose chain grew (the old dead end)", async () => {
    // Exactly the production sequence: union applied, then DropDuplicates
    // appended. Before the fix this was permanently un-deployable — re-applying
    // the union just rewrote the same hardcoded empty hash, and union preview
    // has no `persist`, so no API call could reconcile it.
    let config: Record<string, unknown> = { sourceNodeId: "left", transforms: [] };
    const capture = (c: Record<string, unknown>) => { config = c; return { id: "u1" }; };

    await unionApply(
      stubCtx({
        fetchNodeConfig: async (_p, _pl, id) => ({ id, config: { ...config } }),
        saveNodeConfig: async (_n, _p, c) => capture(c),
      }) as unknown as Parameters<typeof unionApply>[0],
      "p", "pl", "u1", { rightNodeIds: ["right"] },
    );

    config = { ...config, transforms: [{ function: "DropDuplicates", columns: ["account_id"] }] };
    // Reconciliation path: re-apply the union (recomputes the snapshot).
    await unionApply(
      stubCtx({
        fetchNodeConfig: async (_p, _pl, id) => ({ id, config: { ...config } }),
        saveNodeConfig: async (_n, _p, c) => capture(c),
      }) as unknown as Parameters<typeof unionApply>[0],
      "p", "pl", "u1", { rightNodeIds: ["right"] },
    );

    await expect(
      collectPreviewPinning("pl", [{ id: "u1", config }],
        { force: false, ignorePreviewSnapshot: false }),
    ).resolves.toMatchObject({ staleNodeIds: [] });
  });

  it("deploy gate REJECTS a union node whose transform chain drifted (still fail-closed)", async () => {
    const saved = await applyUnion({ sourceNodeId: "left", transforms: [] },
      { rightNodeIds: ["right"] });
    const snap = saved.previewSnapshot as { chainHash: string };
    const drifted = {
      ...saved,
      transforms: [{ function: "DropDuplicates", columns: ["account_id"] }],
      previewSnapshot: snap,
    };
    await expect(
      collectPreviewPinning("pl", [{ id: "u1", config: drifted }],
        { force: false, ignorePreviewSnapshot: false }),
    ).rejects.toMatchObject({ code: "PREVIEW_STALE" });
  });

  it("swapping the union's right-hand input changes the hash (defect 2)", async () => {
    const a = await applyUnion({ sourceNodeId: "left", transforms: [] }, { rightNodeIds: ["rightA"] });
    const b = await applyUnion({ sourceNodeId: "left", transforms: [] }, { rightNodeIds: ["rightB"] });
    expect(chainHashFromNodeConfig(a)).not.toBe(chainHashFromNodeConfig(b));
  });

  it("changing the union column-merge policy changes the hash (defect 2)", async () => {
    const strict = await applyUnion({ sourceNodeId: "left", transforms: [] },
      { rightNodeIds: ["right"], mode: "strict" });
    const wide = await applyUnion({ sourceNodeId: "left", transforms: [] },
      { rightNodeIds: ["right"], mode: "wide" });
    expect(chainHashFromNodeConfig(strict)).not.toBe(chainHashFromNodeConfig(wide));
  });

  it("reordering multi-input unions changes the hash", async () => {
    const ab = await applyUnion({ sourceNodeId: "left", transforms: [] },
      { rightNodeIds: ["rA", "rB"] });
    const ba = await applyUnion({ sourceNodeId: "left", transforms: [] },
      { rightNodeIds: ["rB", "rA"] });
    expect(chainHashFromNodeConfig(ab)).not.toBe(chainHashFromNodeConfig(ba));
  });

  it("a stale union snapshot is still caught even when transforms are unchanged", async () => {
    const saved = await applyUnion({ sourceNodeId: "left", transforms: [] },
      { rightNodeIds: ["right"] });
    // Simulate a legacy snapshot written by the buggy hardcoded empty hash.
    const legacy = {
      ...saved,
      previewSnapshot: { ...(saved.previewSnapshot as object), chainHash: hashTransformChain([]) },
    };
    await expect(
      collectPreviewPinning("pl", [{ id: "u1", config: legacy }],
        { force: false, ignorePreviewSnapshot: false }),
    ).rejects.toMatchObject({ code: "PREVIEW_STALE" });
  });
});

describe("regression: non-union hash compatibility (no blast radius)", () => {
  it("a node with no union wiring keeps the historical payload byte-for-byte", () => {
    const transforms = [{ function: "Filter", conditions: [] }];
    // Pins the pre-fix contract: no union -> hash the bare transform array, so
    // snapshots captured before this change are NOT newly reported stale.
    expect(chainHashFromNodeConfig({ transforms })).toBe(hashTransformChain(transforms));
  });

  it("a node with an empty transform array and no union is unaffected", () => {
    expect(chainHashFromNodeConfig({ transforms: [] })).toBe(hashTransformChain([]));
  });

  it("ignores non-string union ids rather than hashing them", () => {
    expect(chainHashFromNodeConfig({ transforms: [], rightNodeIds: [null, 7] }))
      .toBe(hashTransformChain([]));
  });

  it("tolerates a missing / malformed config", () => {
    expect(chainHashFromNodeConfig(undefined)).toBe(hashTransformChain([]));
    expect(chainHashFromNodeConfig({})).toBe(hashTransformChain([]));
    expect(chainHashFromNodeConfig({ transforms: "nope" })).toBe(hashTransformChain([]));
  });
});
