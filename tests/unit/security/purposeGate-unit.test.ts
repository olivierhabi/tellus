// ---------------------------------------------------------------------------
// tests/unit/security/purposeGate-unit.test.ts
//
// Tests for FOUNDRY-GAPS §8 purpose-based access control:
//   - src/middleware/purposeGate.ts (env-gated enforcement)
//   - src/services/governance/purposeService.ts (decision logic, via a
//     mocked src/db `query` — no database needed)
//   - the readAudit integration (declared purpose lands in the audit row)
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const { queryMock, logMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  logMock: vi.fn(),
}));

vi.mock("../../../src/db", () => ({
  query: queryMock,
  pool: {},
  getClient: vi.fn(),
  withTransaction: vi.fn(),
  queryWithRetry: vi.fn(),
  checkPostgresHealth: vi.fn(),
  isIdempotentSql: vi.fn(),
  default: {},
}));

vi.mock("../../../src/services/funnel/metrics", () => ({
  incCounter: vi.fn(),
  setGauge: vi.fn(),
  observeHistogram: vi.fn(),
}));

vi.mock("../../../src/models/actionAuditLog", () => ({
  logStandaloneFailureAudit: logMock,
  appendAuditRow: vi.fn(),
}));

import { purposeGate } from "../../../src/middleware/purposeGate";
import {
  evaluatePurpose,
  type AccessPurposeRow,
} from "../../../src/services/governance/purposeService";
import {
  readAuditMiddleware,
  annotateReadAudit,
} from "../../../src/middleware/readAudit";

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------
const ONTOLOGY_ID = "00000000-0000-0000-0000-000000000001";

function purposeRow(overrides: Partial<AccessPurposeRow> = {}): AccessPurposeRow {
  return {
    id: "purpose-1",
    ontology_id: ONTOLOGY_ID,
    api_name: "fraud-investigation",
    display_name: "Fraud Investigation",
    description: null,
    allowed_categories: ["object.read", "object.search"],
    expires_at: null,
    created_by: "admin",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    archived_at: null,
    ...overrides,
  };
}

interface DbFixture {
  governed?: boolean;
  purpose?: AccessPurposeRow | null;
  grants?: Array<{ principal_id: string; principal_type: "user" | "group" }>;
}

/** Route the service's SQL to canned rows by table-name fragment. */
function primeDb(fix: DbFixture) {
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM object_type")) {
      return {
        rows: [{ governed_purpose_required: fix.governed ?? true }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM access_purpose")) {
      const rows = fix.purpose ? [fix.purpose] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM purpose_grant")) {
      const rows = fix.grants ?? [];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  });
}

function makeReq(overrides: { purposeHeader?: string } = {}) {
  const headers: Record<string, string> = {};
  if (overrides.purposeHeader !== undefined) {
    headers["x-tellus-purpose"] = overrides.purposeHeader;
  }
  return {
    params: { ontologyId: ONTOLOGY_ID, objectTypeApiName: "Employee" },
    headers,
    auth: { preferred_username: "alice", groups: ["auditors"] },
    method: "GET",
    originalUrl: `/api/v1/ontology/${ONTOLOGY_ID}/objects/Employee/emp-1`,
  } as any;
}

function makeRes() {
  const res: any = new EventEmitter();
  res.locals = {};
  res.statusCode = 200;
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

async function runGate(
  req: any,
  res: any,
  category: "object.read" | "object.search" = "object.read"
) {
  const next = vi.fn();
  await purposeGate(category)(req, res, next);
  return next;
}

function deniedCode(res: any): string | undefined {
  return res.body?.error?.code ?? res.body?.errorCode;
}

async function waitForTick() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("purposeGate middleware", () => {
  const origEnv = process.env.TELLUS_PURPOSE_ENFORCEMENT;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELLUS_PURPOSE_ENFORCEMENT = "on";
    logMock.mockResolvedValue({ auditId: "aud-1", rowHash: "h" });
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.TELLUS_PURPOSE_ENFORCEMENT;
    else process.env.TELLUS_PURPOSE_ENFORCEMENT = origEnv;
  });

  it("enforcement off (default) → pass-through, no DB access, no header needed", async () => {
    delete process.env.TELLUS_PURPOSE_ENFORCEMENT;
    const req = makeReq(); // no header
    const res = makeRes();
    const next = await runGate(req, res);
    expect(next).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("enforcement on but resource NOT governed → pass-through", async () => {
    primeDb({ governed: false });
    const req = makeReq(); // no header
    const res = makeRes();
    const next = await runGate(req, res);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("governed + missing header → 403 PURPOSE_REQUIRED", async () => {
    primeDb({ governed: true });
    const req = makeReq();
    const res = makeRes();
    const next = await runGate(req, res);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(deniedCode(res)).toBe("PURPOSE_REQUIRED");
  });

  it("unknown purpose api_name → 403 PURPOSE_UNKNOWN", async () => {
    primeDb({ governed: true, purpose: null });
    const req = makeReq({ purposeHeader: "no-such-purpose" });
    const res = makeRes();
    const next = await runGate(req, res);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(deniedCode(res)).toBe("PURPOSE_UNKNOWN");
  });

  it("purpose exists but caller has no active (or only revoked) grant → 403 PURPOSE_NOT_GRANTED", async () => {
    // checkPurpose only selects rows WHERE revoked_at IS NULL, so a revoked
    // grant is indistinguishable from no grant: prime zero active grants.
    primeDb({ governed: true, purpose: purposeRow(), grants: [] });
    const req = makeReq({ purposeHeader: "fraud-investigation" });
    const res = makeRes();
    const next = await runGate(req, res);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(deniedCode(res)).toBe("PURPOSE_NOT_GRANTED");
  });

  it("expired purpose → 403 PURPOSE_EXPIRED (even with an active grant)", async () => {
    primeDb({
      governed: true,
      purpose: purposeRow({ expires_at: new Date(Date.now() - 60_000).toISOString() }),
      grants: [{ principal_id: "alice", principal_type: "user" }],
    });
    const req = makeReq({ purposeHeader: "fraud-investigation" });
    const res = makeRes();
    const next = await runGate(req, res);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(deniedCode(res)).toBe("PURPOSE_EXPIRED");
  });

  it("category not in allowed_categories → 403 PURPOSE_CATEGORY_DENIED", async () => {
    primeDb({
      governed: true,
      purpose: purposeRow({ allowed_categories: ["link.list"] }),
      grants: [{ principal_id: "alice", principal_type: "user" }],
    });
    const req = makeReq({ purposeHeader: "fraud-investigation" });
    const res = makeRes();
    const next = await runGate(req, res, "object.read");
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(deniedCode(res)).toBe("PURPOSE_CATEGORY_DENIED");
  });

  it("happy path (user grant) → next() and res.locals.declaredPurpose set", async () => {
    primeDb({
      governed: true,
      purpose: purposeRow(),
      grants: [{ principal_id: "alice", principal_type: "user" }],
    });
    const req = makeReq({ purposeHeader: "fraud-investigation" });
    const res = makeRes();
    const next = await runGate(req, res);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.locals.declaredPurpose).toBe("fraud-investigation");
  });

  it("happy path via group grant → next()", async () => {
    primeDb({
      governed: true,
      purpose: purposeRow(),
      grants: [{ principal_id: "auditors", principal_type: "group" }],
    });
    const req = makeReq({ purposeHeader: "fraud-investigation" });
    const res = makeRes();
    const next = await runGate(req, res);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.locals.declaredPurpose).toBe("fraud-investigation");
  });

  it("fails closed when the governed-flag lookup errors", async () => {
    queryMock.mockRejectedValue(new Error("pg down"));
    const req = makeReq({ purposeHeader: "fraud-investigation" });
    const res = makeRes();
    const next = await runGate(req, res);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("declared purpose lands in the read-audit row (parameters + metadata)", async () => {
    primeDb({
      governed: true,
      purpose: purposeRow(),
      grants: [{ principal_id: "alice", principal_type: "user" }],
    });
    const req = makeReq({ purposeHeader: "fraud-investigation" });
    const res = makeRes();

    // 1. Gate validates and stashes the purpose on res.locals.
    const gateNext = await runGate(req, res);
    expect(gateNext).toHaveBeenCalledTimes(1);

    // 2. readAudit middleware emits after finish — purpose must be present.
    const next = vi.fn();
    readAuditMiddleware()(req, res, next);
    annotateReadAudit(req, {
      category: "object.read",
      ontologyId: ONTOLOGY_ID,
      objectTypeApiName: "Employee",
      primaryKey: "emp-1",
    });
    res.emit("finish");
    await waitForTick();

    expect(logMock).toHaveBeenCalledTimes(1);
    const row = logMock.mock.calls[0][0];
    expect(row.parameters.declared_purpose).toBe("fraud-investigation");
    expect(row.metadata.purpose).toBe("fraud-investigation");
  });
});

describe("evaluatePurpose (pure decision core)", () => {
  it("archived purpose is treated as unknown", () => {
    const d = evaluatePurpose({
      purposeApiName: "fraud-investigation",
      purpose: purposeRow({ archived_at: new Date().toISOString() }),
      activeGrants: [{ principal_id: "alice", principal_type: "user" }],
      category: "object.read",
    });
    expect(d.allowed).toBe(false);
    expect(d.code).toBe("PURPOSE_UNKNOWN");
  });

  it("expiry boundary: expires_at exactly now → expired", () => {
    const now = new Date("2026-06-10T12:00:00Z");
    const d = evaluatePurpose({
      purposeApiName: "fraud-investigation",
      purpose: purposeRow({ expires_at: now.toISOString() }),
      activeGrants: [{ principal_id: "alice", principal_type: "user" }],
      category: "object.read",
      now,
    });
    expect(d.code).toBe("PURPOSE_EXPIRED");
  });

  it("allowed decision carries the purpose identity for audit", () => {
    const d = evaluatePurpose({
      purposeApiName: "fraud-investigation",
      purpose: purposeRow(),
      activeGrants: [{ principal_id: "alice", principal_type: "user" }],
      category: "object.search",
    });
    expect(d.allowed).toBe(true);
    expect(d.purpose).toEqual({ id: "purpose-1", apiName: "fraud-investigation" });
  });
});
