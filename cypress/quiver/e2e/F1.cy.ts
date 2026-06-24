/// <reference types="cypress" />
// Quiver F1 — BE auth surface (cypress smoke exercising the FE-consumed API).
// Covers: F1 C-02, F1 C-08.

describe("F1 — BE-side auth contract", () => {
  it("F1 C-02: POST /analyses without auth → 401 + Tellus:Quiver:Unauthenticated", () => {
    cy.request({
      method: "POST",
      url: `/quiver/api/v1/analyses`,
      failOnStatusCode: false,
      body: { displayName: "x", parentFolderRid: "ri.compass.main.folder.cy" },
    }).then((res) => {
      expect(res.status).to.equal(401);
      expect(res.body.errorName).to.equal("Tellus:Quiver:Unauthenticated");
    });
  });

  it("F1 C-08: with x-test-user, POST /analyses returns 201", () => {
    cy.request({
      method: "POST",
      url: `/quiver/api/v1/analyses`,
      headers: {
        "x-test-user": "ri.multipass.main.user.cy-f1",
        "x-test-org": "ri.multipass.main.org.cy-f1",
        "idempotency-key": crypto.randomUUID(),
        "content-type": "application/json",
      },
      body: { displayName: `cy-f1-${Date.now()}`, parentFolderRid: "ri.compass.main.folder.cy" },
    }).then((res) => {
      expect(res.status).to.equal(201);
    });
  });
});
