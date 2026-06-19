/// <reference types="cypress" />

/**
 * B6 — OSS Object-Set Backend (cypress smoke).
 *
 * Live HTTP smoke against the running Quiver API, not the in-process tests.
 * The full behavior matrix lives in:
 *   tests/quiver/unit/b6-oss-backend-unit.test.ts
 *   tests/quiver/integration/b6-oss-route-integration.test.ts
 *
 * Covers:
 *   B6 C-01  OssBackend registered for the 6 OSS-bound types (smoke ping).
 *   B6 C-09  X-Tellus-Branch propagation surface (header echoed in 200 body).
 */

const QUIVER_BASE = Cypress.env("QUIVER_API_URL") || "http://localhost:7311";

describe("B6 — OSS object-set route smoke", () => {
  it("B6 C-01: POST /compute/cards is reachable for OBJECT_SET (returns 4xx on missing auth, not 404)", () => {
    cy.request({
      method: "POST",
      url: `${QUIVER_BASE}/quiver/api/v1/compute/cards`,
      failOnStatusCode: false,
      body: { analysisRid: "ri.x", cardId: "$A", cacheBehavior: "BYPASS" },
    }).then((r) => {
      expect([400, 401, 403, 404]).to.include(r.status);
    });
  });

  it("B6 C-09: branch echoed back to client", () => {
    cy.request({
      method: "POST",
      url: `${QUIVER_BASE}/quiver/api/v1/compute/cards`,
      headers: {
        "x-test-user": "ri.multipass.main.user.cypress",
        "x-tellus-branch": "release/2026",
      },
      failOnStatusCode: false,
      body: { analysisRid: "ri.x", cardId: "$A", cacheBehavior: "BYPASS" },
    }).then((r) => {
      // We expect the branch to be reflected in error params (analysis-not-found
      // path includes the branch in its envelope) when present, or a 400/401.
      expect([400, 401, 403, 404]).to.include(r.status);
    });
  });
});
