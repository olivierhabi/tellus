// ---------------------------------------------------------------------------
// functionWorkerPool — unit tests.
//
// Covers the sync fallback (runSandboxedWithSdkSync) for correctness of output,
// edits, and error handling, plus the async API's correctness (which succeeds
// via the worker pool OR the sync fallback). The definitive "does not block
// the main event loop" proof lives in scripts/verify-function-worker.ts (run
// under tsx, where the worker is guaranteed to load).
// ---------------------------------------------------------------------------
import { describe, it, expect, vi } from "vitest";
import {
  runSandboxedWithSdkSync,
  runSandboxedWithSdkAsync,
  __resetPoolForTests,
} from "../../../src/services/functionWorkerPool";
import type { OntologySnapshot } from "../../../src/services/functions/ontologyRuntime";

function snapshotWith(
  rows: Array<{ type: string; pk: string; props: Record<string, unknown> }>,
): OntologySnapshot {
  const byType = new Map<string, Map<string, unknown>>();
  for (const r of rows) {
    let bucket = byType.get(r.type);
    if (!bucket) {
      bucket = new Map();
      byType.set(r.type, bucket);
    }
    bucket.set(r.pk, {
      ...r.props,
      $apiName: r.type,
      $primaryKey: r.pk,
      $title: String(r.props.title ?? r.pk),
    });
  }
  return {
    byType,
    ontologyId: "ont-1",
    objectCount: rows.length,
    objectTypes: [...byType.keys()],
  };
}

const EMPTY: OntologySnapshot = {
  byType: new Map(),
  ontologyId: "ont-1",
  objectCount: 0,
  objectTypes: [],
};

describe("runSandboxedWithSdkSync (fallback / inline)", () => {
  it("returns the function's output", async () => {
    const src = `module.exports = function(input){ return input.x + 1; };`;
    const r = await runSandboxedWithSdkSync(src, { x: 41 }, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe(42);
    expect(r.edits).toEqual([]);
  });

  it("exposes the Objects SDK (ambient + via @ontology/sdk)", async () => {
    const snap = snapshotWith([
      { type: "Order", pk: "o1", props: { status: "open", amount: 10 } },
      { type: "Order", pk: "o2", props: { status: "open", amount: 20 } },
    ]);
    const src = `module.exports = function(){ return Objects.search("Order").count(); };`;
    const r = await runSandboxedWithSdkSync(src, {}, snap);
    expect(r.status).toBe("ok");
    expect(r.output).toBe(2);
  });

  it("collects side-channel edits via the Edits API", async () => {
    const src = `module.exports = function(){ Edits.update("Order","o1",{status:"closed"}); return "done"; };`;
    const r = await runSandboxedWithSdkSync(src, {}, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe("done");
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]).toMatchObject({ op: "update", objectType: "Order", primaryKey: "o1" });
  });

  it("surfaces a thrown error as status=error", async () => {
    const src = `module.exports = function(){ throw new Error("boom"); };`;
    const r = await runSandboxedWithSdkSync(src, {}, EMPTY);
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("boom");
    expect(r.edits).toEqual([]);
  });

  it("resolves async functions (Foundry v2 returns Promise<T>)", async () => {
    const src = `module.exports = async function(){ return 1; };`;
    const r = await runSandboxedWithSdkSync(src, {}, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe(1);
  });

  it("surfaces an async rejection as status=error", async () => {
    const src = `module.exports = async function(){ throw new Error("async-boom"); };`;
    const r = await runSandboxedWithSdkSync(src, {}, EMPTY);
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("async-boom");
  });

  it("times out a never-resolving async function", async () => {
    vi.useFakeTimers();
    try {
      const src = `module.exports = function(){ return new Promise(() => {}); };`;
      const pending = runSandboxedWithSdkSync(src, {}, EMPTY);
      await vi.advanceTimersByTimeAsync(6000);
      const r = await pending;
      expect(r.status).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runSandboxedWithSdkAsync (worker pool or fallback)", () => {
  it("returns the function's output (via worker or fallback)", async () => {
    __resetPoolForTests();
    const src = `module.exports = function(input){ return input.x * 2; };`;
    const r = await runSandboxedWithSdkAsync(src, { x: 21 }, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe(42);
    expect(r.edits).toEqual([]);
  });

  it("collects edits across the worker boundary", async () => {
    __resetPoolForTests();
    const src = `module.exports = function(){ Edits.update("Order","o9",{status:"x"}); return 7; };`;
    const r = await runSandboxedWithSdkAsync(src, {}, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe(7);
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]).toMatchObject({ op: "update", objectType: "Order", primaryKey: "o9" });
  });

  it("resolves async functions via the worker pool", async () => {
    __resetPoolForTests();
    const src = `module.exports = async function(input){ return input.x * 3; };`;
    const r = await runSandboxedWithSdkAsync(src, { x: 14 }, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe(42);
  });
});

describe("v2 calling convention — (client, ...params)", () => {
  // Palantir TypeScript v2 Ontology edit functions declare an injected
  // `client` first parameter; Action parameters follow and bind BY NAME
  // from the input. The sandbox injects a placeholder client (the edit
  // batch ignores it) and binds the remaining params from the input.

  const EDIT_FN = `
    module.exports = function markOrderUrgent(client, order) {
      const batch = createEditBatch(client);
      batch.update(order, { status: "URGENT" });
      return batch.getEdits();
    };
  `;

  it("injects the placeholder client and binds params by name", async () => {
    const r = await runSandboxedWithSdkSync(
      EDIT_FN,
      { order: { $apiName: "Order", $primaryKey: "o1" } },
      EMPTY,
    );
    expect(r.status).toBe("ok");
    expect(r.output).toEqual([
      { op: "update", objectType: "Order", primaryKey: "o1", patch: { status: "URGENT" } },
    ]);
  });

  it("binds multiple Action parameters by name, in declared order", async () => {
    const src = `
      module.exports = function rename(client, order, status) {
        const batch = createEditBatch(client);
        batch.update(order, { status });
        return batch.getEdits();
      };
    `;
    const r = await runSandboxedWithSdkSync(
      src,
      { order: { $apiName: "Order", $primaryKey: "o2" }, status: "closed" },
      EMPTY,
    );
    expect(r.status).toBe("ok");
    expect(r.output).toEqual([
      { op: "update", objectType: "Order", primaryKey: "o2", patch: { status: "closed" } },
    ]);
  });

  it("keeps the legacy single-argument convention for one-param functions", async () => {
    const src = `module.exports = function(page){ return page.objectType; };`;
    const r = await runSandboxedWithSdkSync(src, { objectType: "Order" }, EMPTY);
    expect(r.status).toBe("ok");
    expect(r.output).toBe("Order");
  });

  it("throws a precise error when user code calls into the placeholder client", async () => {
    const src = `module.exports = function(client, order){ return client.fetch(order); };`;
    const r = await runSandboxedWithSdkSync(
      src,
      { order: { $apiName: "Order", $primaryKey: "o1" } },
      EMPTY,
    );
    expect(r.status).toBe("error");
    expect(r.errorMessage).toContain("client.fetch is not available");
  });
});
