import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeAction: vi.fn(),
  requireOntology: vi.fn(async () => "ontology-id"),
}));

vi.mock("../../../src/actions/actionExecutor", () => ({
  executeAction: mocks.executeAction,
}));
vi.mock("../../../src/routes/v2/ontologyParam", () => ({
  requireOntology: mocks.requireOntology,
}));
vi.mock("../../../src/utils/requestTenant", () => ({
  resolveRequestTenant: () => "tenant-test",
}));

import actionsV2Router from "../../../src/routes/v2/actionsV2";
import { requestTimeoutMiddleware } from "../../../src/middleware/requestTimeout";

function app(timeoutMs?: number) {
  const instance = express();
  instance.use(express.json());
  if (timeoutMs !== undefined) {
    instance.use(requestTimeoutMiddleware({ timeoutMs }));
  }
  instance.use((req, _res, next) => {
    Object.assign(req, {
      user: { id: "user-1" },
      security: {
        userId: "user-1",
        markings: ["M1"],
        cbac: [],
        systemPrincipal: false,
        markingBypass: false,
      },
    });
    next();
  });
  instance.use("/api/v2/ontologies/:ontology", actionsV2Router);
  return instance;
}

const validValidation = {
  result: "VALID" as const,
  submissionCriteria: [],
  parameters: {},
};

describe("actionsV2 route contract", () => {
  beforeEach(() => {
    mocks.executeAction.mockReset();
  });

  it("VALIDATE_ONLY runs validation gates and returns a 200 validation body", async () => {
    mocks.executeAction.mockResolvedValue({
      success: true,
      executionId: "operation-1",
      result: "success",
      failureType: null,
      errorMessage: null,
      affectedObjects: [],
      durationMs: 1,
      validation: validValidation,
    });

    const response = await request(app())
      .post("/api/v2/ontologies/main/actions/Promote/apply?branch=dev")
      .send({
        parameters: { employeeId: "E-1" },
        options: { mode: "VALIDATE_ONLY" },
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      operationId: "operation-1",
      validation: validValidation,
    });
    expect(mocks.executeAction).toHaveBeenCalledWith(
      "ontology-id",
      "Promote",
      { employeeId: "E-1" },
      expect.objectContaining({
        validateOnly: true,
        returnValidationErrors: true,
        branchId: "dev",
        tenant: "tenant-test",
      }),
    );
  });

  it("returns INVALID validation as 200 instead of translating it to an HTTP error", async () => {
    mocks.executeAction.mockResolvedValue({
      success: false,
      executionId: "operation-invalid",
      result: "failed",
      failureType: "invalid_parameter",
      errorMessage: "employeeId is required",
      affectedObjects: [],
      durationMs: 1,
      validation: {
        result: "INVALID",
        submissionCriteria: [],
        parameters: {
          employeeId: {
            result: "INVALID",
            evaluatedConstraints: [],
            required: true,
          },
        },
      },
    });

    const response = await request(app())
      .post("/api/v2/ontologies/main/actions/Promote/apply")
      .send({ parameters: {} });

    expect(response.status).toBe(200);
    expect(response.body.validation.result).toBe("INVALID");
  });

  it("ALL_V2_WITH_DELETIONS returns the SDK edit discriminator and counts", async () => {
    mocks.executeAction.mockResolvedValue({
      success: true,
      executionId: "operation-2",
      result: "success",
      failureType: null,
      errorMessage: null,
      durationMs: 1,
      validation: validValidation,
      affectedObjects: [
        { objectType: "Employee", primaryKey: "E-1", operation: "delete" },
      ],
    });

    const response = await request(app())
      .post("/api/v2/ontologies/main/actions/Promote/apply")
      .send({
        parameters: {},
        options: { returnEdits: "ALL_V2_WITH_DELETIONS" },
      });

    expect(response.status).toBe(200);
    expect(response.body.edits).toMatchObject({
      type: "edits",
      deletedObjectsCount: 1,
      edits: [
        {
          type: "deleteObject",
          objectType: "Employee",
          primaryKey: "E-1",
        },
      ],
    });
  });

  it("rejects batches above the documented maximum of 20", async () => {
    const response = await request(app())
      .post("/api/v2/ontologies/main/actions/Promote/applyBatch")
      .send({
        requests: Array.from({ length: 21 }, () => ({ parameters: {} })),
      });

    expect(response.status).toBe(400);
    expect(response.body.errorName).toBe("InvalidApplyActionRequest");
    expect(mocks.executeAction).not.toHaveBeenCalled();
  });

  it("suppresses unsupported batch notifications", async () => {
    mocks.executeAction.mockResolvedValue({
      success: true,
      executionId: "operation-batch",
      result: "success",
      failureType: null,
      errorMessage: null,
      durationMs: 1,
      validation: validValidation,
      affectedObjects: [],
    });

    const response = await request(app())
      .post("/api/v2/ontologies/main/actions/Promote/applyBatch")
      .send({ requests: [{ parameters: {} }] });

    expect(response.status).toBe(200);
    expect(mocks.executeAction).toHaveBeenCalledWith(
      "ontology-id",
      "Promote",
      {},
      expect.objectContaining({ suppressNotifications: true }),
    );
  });

  it("does not send a second response when execution finishes after the request timeout", async () => {
    mocks.executeAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                success: true,
                executionId: "operation-late",
                result: "success",
                failureType: null,
                errorMessage: null,
                affectedObjects: [],
                durationMs: 25,
                validation: validValidation,
              }),
            25,
          );
        }),
    );

    const response = await request(app(5))
      .post("/api/v2/ontologies/main/actions/Promote/apply")
      .send({ parameters: {} });

    expect(response.status).toBe(504);
    expect(response.body.errorName).toBe("RequestTimeout");
    await new Promise((resolve) => setTimeout(resolve, 35));
  });
});
