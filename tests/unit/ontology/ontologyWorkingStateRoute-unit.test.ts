import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  getWorkingState: vi.fn(),
  stageChange: vi.fn(),
  discardChange: vi.fn(),
  discardResource: vi.fn(),
  discardAll: vi.fn(),
  acknowledgeChange: vi.fn(),
  updateWorkingState: vi.fn(),
  commitWorkingState: vi.fn(),
}));

vi.mock("../../../src/services/ontologyWorkingStateService", () => service);
import router from "../../../src/routes/ontologyWorkingState";

const review = { ontologyId: "ontology-1", branchName: "main", changes: [], editCount: 0, errorCount: 0, warningCount: 0 };

function app() {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    (req as typeof req & { user: { id: string; roles: string[] } }).user = { id: "user-a", roles: ["ontology-editor"] };
    next();
  });
  value.use("/api/v1/ontology/:ontologyId/working-state", router);
  value.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: error.message }));
  return value;
}

describe("Ontology working-state route contract", () => {
  beforeEach(() => {
    Object.values(service).forEach((mock) => mock.mockReset().mockResolvedValue(review));
  });

  it("scopes reads and staged changes to the authenticated principal and branch", async () => {
    expect((await request(app()).get("/api/v1/ontology/ontology-1/working-state?branch=feature")).status).toBe(200);
    expect(service.getWorkingState).toHaveBeenCalledWith("ontology-1", "user-a", "feature");

    const response = await request(app()).put("/api/v1/ontology/ontology-1/working-state/changes/server-id?branch=feature")
      .send({ changeId: "spoofed", resourceKind: "objectType", resourceId: "Order", operation: "modify", summary: "Update" });
    expect(response.status).toBe(200);
    expect(service.stageChange).toHaveBeenCalledWith("ontology-1", "user-a", "feature", expect.objectContaining({ changeId: "server-id" }));
  });

  it("allows an editor to discard only their private change", async () => {
    const response = await request(app()).delete("/api/v1/ontology/ontology-1/working-state/changes/change-a");
    expect(response.status).toBe(200);
    expect(service.discardChange).toHaveBeenCalledWith("ontology-1", "user-a", "main", "change-a");
  });

  it("forwards the idempotency key at the single commit boundary", async () => {
    const response = await request(app()).post("/api/v1/ontology/ontology-1/working-state/commit")
      .set("Idempotency-Key", "retry-key")
      .send({ target: "newBranch", branchName: "protected-edit" });
    expect(response.status).toBe(200);
    expect(service.commitWorkingState).toHaveBeenCalledWith("ontology-1", "user-a", "main",
      { target: "newBranch", branchName: "protected-edit", branchDescription: undefined }, "retry-key");
  });
});
