/// <reference types="cypress" />
// Quiver B2 — DAG validator e2e against live API.
// Covers: B2 C-13 (HTTP _validate endpoint), B2 C-04, B2 C-05.

describe("B2 — POST /quiver/api/v1/analyses/:rid/_validate", () => {
  const headers = {
    "x-test-user": "ri.multipass.main.user.cy-b2",
    "x-test-org": "ri.multipass.main.org.cy-b2",
  };

  const create = (): Cypress.Chainable<{ rid: string }> =>
    cy
      .request({
        method: "POST",
        url: `/quiver/api/v1/analyses`,
        headers: { ...headers, "idempotency-key": crypto.randomUUID() },
        body: {
          displayName: `cy-b2-${Date.now()}`,
          parentFolderRid: "ri.compass.main.folder.cy",
        },
      })
      .then((res) => {
        expect(res.status).to.equal(201);
        return cy.wrap({ rid: res.body.rid });
      });

  it("B2 C-13: empty document validates → 200", () => {
    create().then(({ rid }) => {
      cy.request({
        method: "POST",
        url: `/quiver/api/v1/analyses/${encodeURIComponent(rid)}/_validate`,
        headers,
      }).then((res) => {
        expect(res.status).to.equal(200);
        expect(res.body.valid).to.equal(true);
      });
    });
  });

  it("B2 C-13: missing auth → 401 with Conjure envelope", () => {
    create().then(({ rid }) => {
      cy.request({
        method: "POST",
        url: `/quiver/api/v1/analyses/${encodeURIComponent(rid)}/_validate`,
        failOnStatusCode: false,
      }).then((res) => {
        expect(res.status).to.equal(401);
        expect(res.body.errorName).to.equal("Tellus:Quiver:Unauthenticated");
      });
    });
  });
});
