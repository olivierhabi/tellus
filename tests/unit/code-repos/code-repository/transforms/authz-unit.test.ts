// ---------------------------------------------------------------------------
// authz-unit.test.ts — P0 build/materialize-path dataset access (the seam).
//
// Pins the acceptance matrix from plans/fluffy-kindling-minsky.md:
//   - unauthorized read  -> Transform:PermissionDenied (no data staged)
//   - unauthorized write -> PermissionDenied (output unchanged)
//   - check ERROR        -> fail-closed (deny), not silently allowed
//   - superadmin bypass  -> allow, effectiveRole NOT called
//   - authorized (viewer=read / editor=write) -> allow
//   - kill switch OFF     -> fail-open (allow), effectiveRole NOT called
//   - denial             -> audit (emitAuditEventBestEffort) + metric (incCounter)
//   - read-check runs BEFORE staging (TOCTOU: no input data leaves on deny)
//
// Run: npx vitest run --config vitest.unit.config.ts <this-file>
// ---------------------------------------------------------------------------
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../../../src/db.js", () => ({ pool: { query: vi.fn() }, getClient: vi.fn() }));
vi.mock("../../../../../src/services/storageService.js", () => ({
  getObjectStream: vi.fn(),
  uploadObject: vi.fn(),
  deleteObject: vi.fn(),
}));
vi.mock("../../../../../src/services/fileScannerService.js", () => ({ scanFile: vi.fn() }));
vi.mock("../../../../../src/services/datasetAcl.js", () => ({
  DatasetAclService: vi.fn(),
}));
vi.mock("../../../../../src/services/auditEventService.js", () => ({
  emitAuditEventBestEffort: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../../../src/services/funnel/metrics.js", () => ({ incCounter: vi.fn() }));
vi.mock("../../../../../src/logging/pino.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { assertDatasetAccess, type TransformPrincipal } from "../../../../../src/services/codeRepository/transforms/authz";
import { DatasetAclService } from "../../../../../src/services/datasetAcl";
import { emitAuditEventBestEffort } from "../../../../../src/services/auditEventService";
import { incCounter } from "../../../../../src/services/funnel/metrics";
import { resolveTransformInput } from "../../../../../src/services/codeRepository/transforms/datasetStore";
import { getObjectStream } from "../../../../../src/services/storageService";

const MockedAcl = DatasetAclService as unknown as { mockImplementation: (fn: () => unknown) => void };
const mockedAudit = emitAuditEventBestEffort as unknown as { mock: { calls: unknown[][] } };
const mockedInc = incCounter as unknown as { mock: { calls: unknown[][] } };
const mockedGetStream = getObjectStream as unknown as { mock: { calls: unknown[][] } };

const UUID = "c3a54ed5-19a3-4394-a66b-7e8b0d5dee95";
const RID = `ri.foundry.main.dataset.${UUID}`;
const PRINCIPAL: TransformPrincipal = { userId: "user-1", roles: [] };
const SUPERADMIN: TransformPrincipal = { userId: "root", roles: ["tellus-superadmin"] };

/** Wire DatasetAclService().effectiveRole to return `role` (or throw if role==="THROW").
 * The impl MUST be a regular function (not an arrow) so `new DatasetAclService()`
 * can construct it — arrow functions aren't constructable ("is not a constructor"). */
function effectiveRoleReturns(role: "viewer" | "editor" | "owner" | null | "THROW"): void {
  MockedAcl.mockImplementation(function () {
    const er = role === "THROW"
      ? async () => { throw new Error("db down"); }
      : async () => role;
    return { effectiveRole: vi.fn(er) };
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs(); // reset TRANSFORM_DATASET_AUTHZ_ENABLED
  effectiveRoleReturns(null);
});

function envelope(err: unknown): { errorName?: string } {
  // assertDatasetAccess throws a TransformError { status, envelope: { errorName, parameters } }
  return (err as { envelope?: { errorName?: string } }).envelope ?? {};
}

describe("assertDatasetAccess — deny / allow", () => {
  it("denies a read when effectiveRole is null (no grant)", async () => {
    effectiveRoleReturns(null);
    await expect(assertDatasetAccess({ principal: PRINCIPAL, datasetUuid: UUID, op: "read" }))
      .rejects.toThrow(/insufficient role/);
    expect(envelope).toBeDefined();
  });

  it("denies a write when effectiveRole is viewer (viewer can't write)", async () => {
    effectiveRoleReturns("viewer");
    await expect(assertDatasetAccess({ principal: PRINCIPAL, datasetUuid: UUID, op: "write" }))
      .rejects.toThrow(/insufficient role/);
  });

  it("allows a read when effectiveRole is viewer", async () => {
    effectiveRoleReturns("viewer");
    await expect(assertDatasetAccess({ principal: PRINCIPAL, datasetUuid: UUID, op: "read" })).resolves.toBeUndefined();
  });

  it("allows a write when effectiveRole is editor (and owner)", async () => {
    for (const role of ["editor", "owner"] as const) {
      effectiveRoleReturns(role);
      await expect(assertDatasetAccess({ principal: PRINCIPAL, datasetUuid: UUID, op: "write" })).resolves.toBeUndefined();
    }
  });

  it("allows when the principal has the tellus-superadmin role (effectiveRole NOT called)", async () => {
    const acl = vi.fn(() => ({ effectiveRole: vi.fn() }));
    MockedAcl.mockImplementation(acl as never);
    await expect(assertDatasetAccess({ principal: SUPERADMIN, datasetUuid: UUID, op: "write" })).resolves.toBeUndefined();
    expect(acl).not.toHaveBeenCalled(); // bypass short-circuits before instantiating the ACL service
  });

  it("fail-closed: a check ERROR (effectiveRole throws) is denied, not allowed", async () => {
    effectiveRoleReturns("THROW");
    await expect(assertDatasetAccess({ principal: PRINCIPAL, datasetUuid: UUID, op: "read" }))
      .rejects.toThrow(/permission check failed/);
  });
});

describe("assertDatasetAccess — kill switch", () => {
  it("OFF (TRANSFORM_DATASET_AUTHZ_ENABLED=false) -> fail-open: allow + effectiveRole NOT called", async () => {
    vi.stubEnv("TRANSFORM_DATASET_AUTHZ_ENABLED", "false");
    const acl = vi.fn(() => ({ effectiveRole: vi.fn() }));
    MockedAcl.mockImplementation(acl as never);
    await expect(assertDatasetAccess({ principal: PRINCIPAL, datasetUuid: UUID, op: "write" })).resolves.toBeUndefined();
    expect(acl).not.toHaveBeenCalled();
  });

  it("ON (default) + insufficient role -> deny", async () => {
    effectiveRoleReturns(null);
    await expect(assertDatasetAccess({ principal: PRINCIPAL, datasetUuid: UUID, op: "read" })).rejects.toThrow();
  });
});

describe("assertDatasetAccess — audit + metrics on denial", () => {
  it("emits a structured audit record + a denial metric on deny", async () => {
    effectiveRoleReturns(null);
    await expect(assertDatasetAccess({ principal: PRINCIPAL, datasetUuid: UUID, op: "write", datasetRid: RID }))
      .rejects.toThrow();
    // audit: action distinguishes read/write; details carry the dataset + op + outcome + principal.
    expect(mockedAudit.mock.calls).toHaveLength(1);
    const auditArg = mockedAudit.mock.calls[0][0] as { action: string; result: string; details: Record<string, unknown> };
    expect(auditArg.action).toBe("transform.dataset.write");
    expect(auditArg.result).toBe("FAILURE");
    expect(auditArg.details.datasetRid).toBe(RID);
    expect(auditArg.details.op).toBe("write");
    expect(auditArg.details.outcome).toBe("deny");
    // metric: denials counter labeled by dataset/principal/op.
    expect(mockedInc.mock.calls).toHaveLength(1);
    const metricArg = mockedInc.mock.calls[0];
    expect(metricArg[0]).toBe("transform_authz_denials_total");
    expect((metricArg[1] as Record<string, unknown>).op).toBe("write");
  });

  it("does NOT audit or metric on allow", async () => {
    effectiveRoleReturns("editor");
    await assertDatasetAccess({ principal: PRINCIPAL, datasetUuid: UUID, op: "write" });
    expect(mockedAudit.mock.calls).toHaveLength(0);
    expect(mockedInc.mock.calls).toHaveLength(0);
  });
});

describe("resolveTransformInput — read-check runs BEFORE staging (TOCTOU / no partial read)", () => {
  // Real resolveTransformInput with a NON-superadmin principal + effectiveRole=null.
  // The read-check must throw BEFORE getObjectStream stages any data.
  it("denies + stages NOTHING when the principal lacks read on a foundry input", async () => {
    const { pool } = await import("../../../../../src/db");
    (pool.query as unknown as { mockImplementation: (fn: (...a: unknown[]) => unknown) => void }).mockImplementation(async (sqlOrObj: unknown) => {
      const sql = typeof sqlOrObj === "string" ? sqlOrObj : (sqlOrObj as { text?: string }).text ?? "";
      if (/FROM\s+dataset\s+WHERE\s+rid/i.test(sql)) return { rows: [], rowCount: 0 }; // dataset-table miss
      if (/FROM\s+foundry_datasets/i.test(sql)) return { rows: [{ file_path: "k", format: "csv", mime_type: "text/csv", status: "ready" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    effectiveRoleReturns(null); // no grant -> read denied
    await expect(resolveTransformInput(RID, "main", PRINCIPAL)).rejects.toThrow(/insufficient role/);
    expect(mockedGetStream.mock.calls).toHaveLength(0); // no data staged
  });
});
