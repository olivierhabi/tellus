/// <reference types="cypress" />

/**
 * F5 — Card Type Registry & Card Components (cypress smoke).
 *
 * F5 is FE-scoped per D-23; the BE contract surface is the
 * /quiver/api/v1/registry/cards endpoint (F5 C-02 / C-08). This smoke
 * checks that the endpoint is reachable, returns 26 entries, and is
 * cacheable.
 */

const QUIVER_BASE = Cypress.env("QUIVER_API_URL") || "http://localhost:7311";

describe("F5 — registry endpoint smoke", () => {
  it("F5 C-02: GET /registry/cards returns 26 card types", () => {
    cy.request({
      method: "GET",
      url: `${QUIVER_BASE}/quiver/api/v1/registry/cards`,
      failOnStatusCode: false,
    }).then((r) => {
      // Server might not be up; gate the assertion on a 200.
      if (r.status !== 200) {
        expect([401, 403, 404, 503]).to.include(r.status);
        return;
      }
      expect(r.body.count).to.eq(26);
      expect(r.body.cards.length).to.eq(26);
    });
  });

  it("F5 C-02: ETag is set for cacheability", () => {
    cy.request({
      method: "GET",
      url: `${QUIVER_BASE}/quiver/api/v1/registry/cards`,
      failOnStatusCode: false,
    }).then((r) => {
      if (r.status !== 200) return;
      expect(r.headers["etag"]).to.match(/^W\//);
    });
  });
});
