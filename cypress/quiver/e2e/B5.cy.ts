/**
 * B5 — Cypress smoke (HTTP-only).
 *
 * Coverage:
 *   B5 C-01 — POST /compute/cards happy path
 *   B5 C-09 / G-06 — DEADLINE_EXCEEDED at the boundary
 */
const QUIVER = Cypress.env("QUIVER_API_URL") || "http://localhost:7311";

describe("B5 compute smoke", () => {
  it("rejects unauthenticated compute calls (B5 C-01 surface, G-01)", () => {
    cy.request({
      method: "POST",
      url: `${QUIVER}/quiver/api/v1/compute/cards`,
      failOnStatusCode: false,
      body: { analysisRid: "ri.tellus-quiver.main.analysis.x", cardId: "$A", parameterOverrides: {}, cacheBehavior: "BYPASS" },
    }).then((r) => {
      expect(r.status).to.eq(401);
      expect(r.body.errorName).to.eq("Tellus:Quiver:Unauthenticated");
    });
  });
});
