// Tenant-from-row hardening for internalUnwrapWorker (POST /internal/credentials/unwrap).
//
// The vault is tenant-bound, so the unwrap tenant must come from the persisted
// connection row — never from the JWT claim. A token minted for tenant-evil
// must fail closed (403, vault never touched) even when its signature,
// connection_rid, and scope all verify.

import { beforeEach, describe, expect, it, vi } from "vitest";

const RID = "ri.magritte.main.source.22222222-2222-2222-2222-222222222222";
const ROW_TENANT = "tenant-real";

const mockQuery = vi.fn();
vi.mock("../../../src/db", () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
  withTransaction: vi.fn(),
}));

const mockUnwrap = vi.fn();
vi.mock("../../../src/services/connectivity/credentials/vault", () => ({
  unwrap: (...args: unknown[]) => mockUnwrap(...args),
}));

const { internalUnwrapWorker } = await import(
  "../../../src/services/connectivity/handlers/secrets.handler"
);
const { issueWorkloadToken, _resetSecretForTest } = await import(
  "../../../src/services/multipass/tokens"
);

interface Captured {
  status: number;
  body: unknown;
}

function mockRes(): { res: any; captured: Captured } {
  const captured: Captured = { status: 0, body: undefined };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
    send(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
}

function mockReq(token: string): any {
  return {
    body: { connectionRid: RID },
    headers: { authorization: `Bearer ${token}` },
    ip: "127.0.0.1",
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockUnwrap.mockReset();
  process.env.TELLUS_WORKLOAD_JWT_SECRET =
    "test-only-workload-secret-that-is-long-enough-32";
  _resetSecretForTest();
  mockQuery.mockResolvedValue({
    rowCount: 1,
    rows: [{ config: { postgres: { user: "app" } }, tenant: ROW_TENANT }],
  });
});

describe("internalUnwrapWorker tenant handling", () => {
  it("rejects a validly-signed token whose tenant claim differs from the row (vault untouched)", async () => {
    const forgedTenant = issueWorkloadToken({
      subject: "tellus-foundry-worker",
      connectionRid: RID,
      tenant: "tenant-evil",
    });
    const { res, captured } = mockRes();
    await internalUnwrapWorker(mockReq(forgedTenant), res, vi.fn());
    expect(captured.status).toBe(403);
    expect(mockUnwrap).not.toHaveBeenCalled();
  });

  it("unwraps with the row tenant when the claim matches", async () => {
    const legit = issueWorkloadToken({
      subject: "tellus-foundry-worker",
      connectionRid: RID,
      tenant: ROW_TENANT,
    });
    mockUnwrap.mockImplementation(
      async (_rid: string, _tenant: string, field: string) =>
        field === "password"
          ? new Uint8Array(Buffer.from("s3cret"))
          : new Uint8Array(),
    );
    const { res, captured } = mockRes();
    await internalUnwrapWorker(mockReq(legit), res, vi.fn());
    expect(captured.status).toBe(200);
    // Every vault call uses the persisted row tenant, not the claim.
    for (const call of mockUnwrap.mock.calls) {
      expect(call[0]).toBe(RID);
      expect(call[1]).toBe(ROW_TENANT);
    }
    expect((captured.body as any).fields.password).toBe("s3cret");
  });
});
