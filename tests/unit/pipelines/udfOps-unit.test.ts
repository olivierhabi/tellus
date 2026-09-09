// ---------------------------------------------------------------------------
// Unit tests for the extracted UDF op (src/services/pipelines/ops/udfOps.ts).
// The sandbox runner is NOT exercised (it needs the k8s substrate); these
// tests pin spec validation, config persistence, and input plumbing.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/services/pipelines/udfRunner", () => ({
  runUdfTransform: vi.fn(async ({ rows }: { rows: Array<Record<string, unknown>> }) =>
    rows.map((r) => ({ ...r, doubled: String(Number(r.a) * 2) })),
  ),
}));

import { udfApply, udfPreview } from "../../../src/services/pipelines/ops/udfOps";
import { runUdfTransform } from "../../../src/services/pipelines/udfRunner";
import type { TransformOpsContext } from "../../../src/services/pipelines/ops/transformOpsContext";

const VALID_SPEC = {
  language: "python",
  code: "def transform(rows):\n    return rows",
  entrypoint: "transform",
  timeoutSeconds: 30,
  outputColumns: [{ name: "a", type: "string" }, { name: "doubled", type: "string" }],
};

function stubCtx(overrides: Partial<TransformOpsContext> = {}): TransformOpsContext {
  return {
    resolvePreviewInput: async () => ({
      dataset: { id: "d1", file_path: "k.csv", status: "ready" },
      sourceColumns: [{ name: "a", type: "string" }],
      existingTransforms: [],
      baseRows: [{ a: "1" }, { a: "2" }, { a: "3" }],
    }),
    applyExistingTransforms: (rows) => rows,
    applyExistingTransformColumns: (cols) => cols,
    fetchNodeConfig: async (_p, _pl, nodeId) => ({ id: nodeId, config: {} }),
    saveNodeConfig: async (_n, _p, config) => ({ id: "n1", config }),
    assertColumnsExist: () => {},
    resolveNodeData: async () => ({ columns: [], rows: [] }),
    persistExecutionSnapshot: async () => {},
    walkTransitiveInputs: async () => [],
    unionPreview: async () => ({ columns: [], rows: [] }),
    ...overrides,
  };
}

describe("udfOps — udfApply", () => {
  it("validates the spec and persists it on config.udfTransform (NOT config.transforms)", async () => {
    let saved: Record<string, unknown> | undefined;
    const ctx = stubCtx({ saveNodeConfig: async (_n, _p, c) => { saved = c; return {}; } });
    await udfApply(ctx, "p", "pl", "n1", VALID_SPEC);
    expect(saved?.udfTransform).toMatchObject({ language: "python", entrypoint: "transform" });
    expect(saved?.transforms).toBeUndefined();
  });

  it("rejects an invalid spec before any persistence", async () => {
    const saveNodeConfig = vi.fn();
    const ctx = stubCtx({ saveNodeConfig });
    await expect(udfApply(ctx, "p", "pl", "n1", { language: "cobol", code: "x" }))
      .rejects.toThrow();
    expect(saveNodeConfig).not.toHaveBeenCalled();
  });
});

describe("udfOps — udfPreview", () => {
  it("runs the sandbox over the resolved rows and returns declared columns", async () => {
    const out = await udfPreview(stubCtx(), "p", "pl", "n1", VALID_SPEC, 2);
    expect(runUdfTransform).toHaveBeenCalledWith(expect.objectContaining({
      buildRid: "udf-preview-pl-n1",
      tenant: "p",
      rows: [{ a: "1" }, { a: "2" }], // bounded to the limit
    }));
    expect(out.rows.map((r) => r.doubled)).toEqual(["2", "4"]);
    expect(out.columns).toEqual(VALID_SPEC.outputColumns);
    expect(out.truncated).toBe(false);
  });

  it("rejects an invalid spec without touching the sandbox", async () => {
    await expect(udfPreview(stubCtx(), "p", "pl", "n1", {}, 10)).rejects.toThrow();
  });
});
