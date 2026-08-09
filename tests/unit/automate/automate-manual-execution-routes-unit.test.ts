// ---------------------------------------------------------------------------
// HTTP contract tests for the manual-execution readiness endpoints.
//
// Mounts the real automations router on a bare Express app with a security
// middleware shim that sets req.user / req.security / req.tellusPrincipal so
// `actor()`, `resolveRequestTenant()`, and `requireOntologyWrite()` run for
// real. The repository module is mocked so these tests assert the route
// middleware, zod validation, error mapping, and response shapes — not DB
// behavior (which the integration suite covers against a live database).
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const repoMock = vi.hoisted(() => {
  // Mirror the real AutomationServiceError default status (400) so the route's
  // instanceof + status mapping behaves like production.
  class AutomationServiceError extends Error {
    code: string;
    status: number;
    details?: unknown;
    constructor(code: string, message: string, status = 400, details?: unknown) {
      super(message);
      this.code = code;
      this.status = status;
      this.details = details;
    }
  }
  return {
    AutomationServiceError,
    getManualExecutionOptions: vi.fn(),
    executeAutomationManually: vi.fn(),
    getAutomation: vi.fn(),
    activateAutomation: vi.fn(),
    createDraft: vi.fn(),
    cancelTriggerEvent: vi.fn(),
    getExecutionDetails: vi.fn(),
    listAutomations: vi.fn(),
    listAutomationAudit: vi.fn(),
    listConditionEvaluations: vi.fn(),
    listExecutionHistory: vi.fn(),
    retryTriggerEvent: vi.fn(),
    transitionAutomation: vi.fn(),
    updateDraft: vi.fn(),
  };
});

vi.mock("../../../src/services/automate/repository", () => repoMock);

import automationsRouter from "../../../src/routes/automations";

// zod v4's `.uuid()` enforces the RFC 4122 variant/version, so use real v4
// UUIDs rather than placeholder strings like "11111111-...".
const AUTOMATION_ID = crypto.randomUUID();
const EFFECT_ID = crypto.randomUUID();

function makeApp(user: { id: string; roles: string[]; tenant?: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) {
      (req as unknown as { user: unknown }).user = {
        id: user.id,
        roles: user.roles,
        tenant: user.tenant ?? "tenant-1",
        displayName: "Test Actor",
      };
      (req as unknown as { security: unknown }).security = {
        markings: [],
        cbac: [],
        organizations: [],
        markingMode: "disjunctive",
        markingBypass: false,
      };
      (req as unknown as { tellusPrincipal?: unknown }).tellusPrincipal = undefined;
    }
    next();
  });
  app.use("/api/v1/automations", automationsRouter);
  return app;
}

const authedUser = { id: "user-1", roles: ["tellus-superadmin"], tenant: "tenant-1" };

beforeEach(() => {
  repoMock.getManualExecutionOptions.mockReset();
  repoMock.executeAutomationManually.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.resetAllMocks();
});

describe("GET /:automationId/manual-execution-options — HTTP contract", () => {
  it("returns the active version and executable effects", async () => {
    repoMock.getManualExecutionOptions.mockResolvedValue({
      automationId: AUTOMATION_ID,
      version: 4,
      effects: [
        { id: "eff-1", name: "Notify", type: "notification", order: 0 },
        { id: "eff-2", name: "Run", type: "function", order: 1 },
      ],
    });
    const res = await request(makeApp(authedUser)).get(
      `/api/v1/automations/${AUTOMATION_ID}/manual-execution-options`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      automationId: AUTOMATION_ID,
      version: 4,
      effects: [
        { id: "eff-1", name: "Notify", type: "notification", order: 0 },
        { id: "eff-2", name: "Run", type: "function", order: 1 },
      ],
    });
    expect(repoMock.getManualExecutionOptions).toHaveBeenCalledWith({
      automationId: AUTOMATION_ID,
      tenantId: "tenant-1",
      actorUserId: "user-1",
    });
  });

  it("responds 404 without leaking existence when the automation is missing/inaccessible", async () => {
    repoMock.getManualExecutionOptions.mockRejectedValue(
      new repoMock.AutomationServiceError(
        "AUTOMATION_NOT_FOUND",
        "Automation not found.",
        404,
      ),
    );
    const res = await request(makeApp(authedUser)).get(
      `/api/v1/automations/${AUTOMATION_ID}/manual-execution-options`,
    );
    expect(res.status).toBe(404);
    expect(res.body.errorCode).toBe("AUTOMATION_NOT_FOUND");
  });

  it("responds 409 when the automation is not active", async () => {
    repoMock.getManualExecutionOptions.mockRejectedValue(
      new repoMock.AutomationServiceError(
        "AUTOMATION_NOT_EXECUTABLE",
        "Only an active automation can be manually executed.",
        409,
      ),
    );
    const res = await request(makeApp(authedUser)).get(
      `/api/v1/automations/${AUTOMATION_ID}/manual-execution-options`,
    );
    expect(res.status).toBe(409);
  });

  it("requires authentication (401 when no principal)", async () => {
    const res = await request(makeApp(null)).get(
      `/api/v1/automations/${AUTOMATION_ID}/manual-execution-options`,
    );
    expect(res.status).toBe(401);
  });

  it("requires an ontology-write role (403 when unprivileged)", async () => {
    const res = await request(
      makeApp({ id: "user-2", roles: ["ontology-viewer"], tenant: "tenant-1" }),
    ).get(`/api/v1/automations/${AUTOMATION_ID}/manual-execution-options`);
    expect(res.status).toBe(403);
    expect(res.body.errorCode).toBe("INSUFFICIENT_ROLE");
  });

  it("rejects a non-UUID automation id (400)", async () => {
    const res = await request(makeApp(authedUser)).get(
      `/api/v1/automations/not-a-uuid/manual-execution-options`,
    );
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("AUTOMATION_ID_INVALID");
  });
});

describe("POST /:automationId/execute — HTTP contract", () => {
  const validBody = {
    sendCompletionNotification: false,
    selectedEffectIds: [EFFECT_ID],
    expectedVersion: 4,
  };

  it("creates a manual execution and echoes the triggerEventId (201)", async () => {
    repoMock.executeAutomationManually.mockResolvedValue({
      triggerEventId: "trigger-1",
      reused: false,
    });
    const res = await request(makeApp(authedUser))
      .post(`/api/v1/automations/${AUTOMATION_ID}/execute`)
      .set("Idempotency-Key", "key-1")
      .send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ triggerEventId: "trigger-1", reused: false });
    expect(repoMock.executeAutomationManually).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: AUTOMATION_ID,
        expectedVersion: 4,
        selectedEffectIds: [EFFECT_ID],
        idempotencyKey: "key-1",
      }),
    );
  });

  it("returns 200 for a replayed idempotent request", async () => {
    repoMock.executeAutomationManually.mockResolvedValue({
      triggerEventId: "trigger-1",
      reused: true,
    });
    const res = await request(makeApp(authedUser))
      .post(`/api/v1/automations/${AUTOMATION_ID}/execute`)
      .set("Idempotency-Key", "key-1")
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.data.reused).toBe(true);
  });

  it("requires an Idempotency-Key header (400)", async () => {
    const res = await request(makeApp(authedUser))
      .post(`/api/v1/automations/${AUTOMATION_ID}/execute`)
      .send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("rejects a missing expectedVersion guard (validation 422)", async () => {
    const res = await request(makeApp(authedUser))
      .post(`/api/v1/automations/${AUTOMATION_ID}/execute`)
      .set("Idempotency-Key", "key-1")
      .send({
        sendCompletionNotification: false,
        selectedEffectIds: [EFFECT_ID],
      });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe("AUTOMATION_DEFINITION_INVALID");
    expect(repoMock.executeAutomationManually).not.toHaveBeenCalled();
  });

  it("rejects an empty selectedEffectIds array (validation 422)", async () => {
    const res = await request(makeApp(authedUser))
      .post(`/api/v1/automations/${AUTOMATION_ID}/execute`)
      .set("Idempotency-Key", "key-1")
      .send({ ...validBody, selectedEffectIds: [] });
    expect(res.status).toBe(422);
    expect(repoMock.executeAutomationManually).not.toHaveBeenCalled();
  });

  it("returns 409 AUTOMATION_VERSION_STALE when the version guard mismatches", async () => {
    repoMock.executeAutomationManually.mockRejectedValue(
      new repoMock.AutomationServiceError(
        "AUTOMATION_VERSION_STALE",
        "The automation was republished. Refresh manual execution options.",
        409,
        { expectedVersion: 4, activeVersion: 5 },
      ),
    );
    const res = await request(makeApp(authedUser))
      .post(`/api/v1/automations/${AUTOMATION_ID}/execute`)
      .set("Idempotency-Key", "key-1")
      .send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe("AUTOMATION_VERSION_STALE");
  });

  it("returns 400 with the unknown effect ids when selected effects are unknown", async () => {
    repoMock.executeAutomationManually.mockRejectedValue(
      new repoMock.AutomationServiceError(
        "AUTOMATION_EFFECT_NOT_FOUND",
        "One or more selected effects do not exist in the active automation version.",
        400,
        { effectIds: [EFFECT_ID] },
      ),
    );
    const res = await request(makeApp(authedUser))
      .post(`/api/v1/automations/${AUTOMATION_ID}/execute`)
      .set("Idempotency-Key", "key-1")
      .send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe("AUTOMATION_EFFECT_NOT_FOUND");
    expect(res.body.parameters).toMatchObject({
      effectIds: [EFFECT_ID],
    });
  });

  it("requires authentication (401)", async () => {
    const res = await request(makeApp(null))
      .post(`/api/v1/automations/${AUTOMATION_ID}/execute`)
      .set("Idempotency-Key", "key-1")
      .send(validBody);
    expect(res.status).toBe(401);
  });

  it("requires an ontology-write role (403)", async () => {
    const res = await request(
      makeApp({ id: "user-2", roles: ["ontology-viewer"], tenant: "tenant-1" }),
    )
      .post(`/api/v1/automations/${AUTOMATION_ID}/execute`)
      .set("Idempotency-Key", "key-1")
      .send(validBody);
    expect(res.status).toBe(403);
  });
});
