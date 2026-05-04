/// <reference types="cypress" />
// Quiver B4 — versions + working-states e2e against live API.
// Covers: B4 C-01, B4 C-08.

describe("B4 — versions + working-states", () => {
  const headers = {
    "x-test-user": "ri.multipass.main.user.cy-b4",
    "x-test-org": "ri.multipass.main.org.cy-b4",
  };

  const create = (): Cypress.Chainable<{ rid: string; etag: string }> =>
    cy
      .request({
        method: "POST",
        url: `/quiver/api/v1/analyses`,
        headers: { ...headers, "idempotency-key": crypto.randomUUID() },
        body: { displayName: `cy-b4-${Date.now()}`, parentFolderRid: "ri.compass.main.folder.cy" },
      })
      .then((res) => {
        expect(res.status).to.equal(201);
        return cy.wrap({ rid: res.body.rid, etag: res.headers["etag"] as string });
      });

  it("B4 C-01: saveVersion 412 without If-Match", () => {
    create().then(({ rid }) => {
      cy.request({
        method: "POST",
        url: `/quiver/api/v1/analyses/${encodeURIComponent(rid)}/versions`,
        headers,
        body: {},
        failOnStatusCode: false,
      }).then((res) => {
        expect(res.status).to.equal(412);
        expect(res.body.errorName).to.equal("Tellus:Quiver:VersionMismatch");
      });
    });
  });

  it("B4 C-08: working-state create returns base36(10) stateId", () => {
    create().then(({ rid }) => {
      cy.request({
        method: "POST",
        url: `/quiver/api/v1/analyses/${encodeURIComponent(rid)}/working-states`,
        headers,
        body: {},
      }).then((res) => {
        expect(res.status).to.equal(201);
        expect(res.body.stateId).to.match(/^[a-z0-9]{10}$/);
      });
    });
  });
});
