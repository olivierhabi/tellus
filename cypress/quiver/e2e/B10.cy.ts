/// <reference types="cypress" />

// B10 — Dashboards / Visual Functions / Templates — live API smoke.

describe("B10 — Publishing surface", () => {
  it("B10 C-12: missing Idempotency-Key on POST /dashboards → 400", () => {
    cy.request({
      method: "POST",
      url: "/quiver/api/v1/dashboards",
      failOnStatusCode: false,
      headers: { "x-test-user": "ri.multipass.main.user.alice" },
      body: {
        analysisRid:
          "ri.tellus-quiver.main.analysis.018f4a9c-7d6e-7c8a-87b0-0123456789ab",
        displayName: "x",
        exposedCanvases: ["main"],
        parameterSchema: { type: "object", properties: {}, required: [] },
      },
    }).then((r) => {
      expect(r.status).to.eq(400);
    });
  });

  it("B10 C-17: Templates returns Deprecation: true", () => {
    cy.request({
      method: "POST",
      url: "/quiver/api/v1/templates",
      failOnStatusCode: false,
      headers: { "x-test-user": "ri.multipass.main.user.alice" },
      body: {
        parentFolderRid: "ri.compass.main.folder.f1",
        displayName: "Legacy",
        snapshot: {},
      },
    }).then((r) => {
      expect(r.headers.deprecation).to.eq("true");
    });
  });
});
