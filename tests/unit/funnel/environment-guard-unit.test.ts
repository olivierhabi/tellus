// ---------------------------------------------------------------------------
// FUNN-ISO — environment guard unit tests (pure unit; the DB seal is
// injected, so these run offline against vitest.unit.config).
//
// The fence compares three values: the context's environment id, the
// worker's configured id, and the database's sealed id. The tests pin
// every divergent permutation so a regression in ANY comparison is caught.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";

// mock the db module BEFORE importing the guard so the seal read is
// injected — the fence never touches real Postgres here.
const mockQuery = vi.fn();
vi.mock("../../../src/db", () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

import {
  fenceExecutionContext,
  FunnelExecutionEnvironmentMismatch,
  FunnelObjectTypeMissing,
  resolveExpectedObjectType,
  __resetEnvironmentSealForTesting,
} from "../../../src/services/funnel/environmentGuard";
import { __resetEnvironmentIdentityForTesting } from "../../../src/config/environmentIdentity";

const WORKER_ENV = "tellus-dev";

function primeSeal(seal: string | null): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/deployment_environment/i.test(sql)) {
      return { rows: seal ? [{ environment_id: seal }] : [] };
    }
    return { rows: [] };
  });
}

beforeEachFix();
function beforeEachFix(): void {
  __resetEnvironmentSealForTesting();
  __resetEnvironmentIdentityForTesting();
  mockQuery.mockReset();
  process.env.TELLUS_ENVIRONMENT_ID = WORKER_ENV;
  delete process.env.TELLUS_DEPLOYMENT_STRICT;
}

describe("environmentGuard fence (FUNN-ISO)", () => {
  it("ctx env == worker env == db seal → passes", async () => {
    beforeEachFix();
    primeSeal(WORKER_ENV);
    const out = await fenceExecutionContext({ environmentId: WORKER_ENV });
    expect(out.dbEnvironmentId).toBe(WORKER_ENV);
  });

  it("missing ctx env → context_vs_worker mismatch (non-retryable by contract)", async () => {
    beforeEachFix();
    primeSeal(WORKER_ENV);
    await expect(fenceExecutionContext({})).rejects.toThrow(
      FunnelExecutionEnvironmentMismatch,
    );
    try {
      await fenceExecutionContext({});
      expect.unreachable();
    } catch (err) {
      expect((err as FunnelExecutionEnvironmentMismatch).source).toBe("context_vs_worker");
      expect((err as FunnelExecutionEnvironmentMismatch).actual).toBe("<missing>");
    }
  });

  it("ctx env ≠ worker env → mismatch, expected=worker actual=ctx", async () => {
    beforeEachFix();
    primeSeal(WORKER_ENV);
    try {
      await fenceExecutionContext({ environmentId: "other-env" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FunnelExecutionEnvironmentMismatch);
      expect((err as FunnelExecutionEnvironmentMismatch).source).toBe("context_vs_worker");
      expect((err as FunnelExecutionEnvironmentMismatch).expected).toBe(WORKER_ENV);
      expect((err as FunnelExecutionEnvironmentMismatch).actual).toBe("other-env");
    }
  });

  it("db seal ≠ worker env → context_vs_db mismatch (the split-brain signature)", async () => {
    beforeEachFix();
    primeSeal("other-db-env");
    try {
      await fenceExecutionContext({ environmentId: WORKER_ENV });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FunnelExecutionEnvironmentMismatch);
      expect((err as FunnelExecutionEnvironmentMismatch).source).toBe("context_vs_db");
      expect((err as FunnelExecutionEnvironmentMismatch).expected).toBe(WORKER_ENV);
      expect((err as FunnelExecutionEnvironmentMismatch).actual).toBe("other-db-env");
    }
  });

  it("error name is stable for workflow-side cause-chain type matching", () => {
    const err = new FunnelExecutionEnvironmentMismatch("worker_vs_db", "a", "b");
    expect(err.name).toBe("FunnelExecutionEnvironmentMismatch");
    expect(err.message).toContain("worker_vs_db");
    expect(err.message).toContain("expected='a'");
    expect(err.message).toContain("actual='b'");
  });

  it("resolveExpectedObjectType: missing row → FunnelObjectTypeMissing (never silent)", async () => {
    beforeEachFix();
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(
      resolveExpectedObjectType({
        environmentId: WORKER_ENV,
        ontologyRid: "00000000-0000-0000-0000-000000000001",
        objectTypeApiName: "Ghost",
      }),
    ).rejects.toThrow(FunnelObjectTypeMissing);
  });

  it("resolveExpectedObjectType: rid divergence → FunnelObjectTypeMissing", async () => {
    beforeEachFix();
    mockQuery.mockResolvedValue({
      rows: [{ object_type_id: "aaa", ontology_id: "ooo", api_name: "X" }],
    });
    await expect(
      resolveExpectedObjectType({
        environmentId: WORKER_ENV,
        ontologyRid: "ooo",
        objectTypeApiName: "X",
        objectTypeRid: "different-rid",
      }),
    ).rejects.toThrow(FunnelObjectTypeMissing);
  });

  it("resolveExpectedObjectType: consistent triple → returns row", async () => {
    beforeEachFix();
    mockQuery.mockResolvedValue({
      rows: [{ object_type_id: "aaa", ontology_id: "ooo", api_name: "X" }],
    });
    const out = await resolveExpectedObjectType({
      environmentId: WORKER_ENV,
      ontologyRid: "ooo",
      objectTypeApiName: "X",
      objectTypeRid: "aaa",
    });
    expect(out.object_type_id).toBe("aaa");
  });
});

afterEach(() => {
  beforeEachFix();
});
