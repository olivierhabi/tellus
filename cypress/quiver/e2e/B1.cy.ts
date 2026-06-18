// Cypress E2E for B1 — Analysis Document Storage.
//
// Each `it()` block is annotated with the C-IDs it exercises so
// `scripts/quiver-coverage-check.sh` can verify coverage without running
// Cypress.
//
// Per D-14, the runner stays gated on CYPRESS_BIN; in CI this spec runs
// against a live Quiver API on `http://127.0.0.1:7311`.

const folder = "ri.compass.main.folder.cypress-b1";

describe("Quiver B1 — Analysis CRUD (B1 C-01..C-26 + G-01..G-13)", () => {
  let rid = "";
  let etag = "";

  it("B1 C-01 / G-01: POST /analyses returns 201 + Location + ETag + UUIDv7 RID", () => {
    cy.request({
      method: "POST",
      url: "/quiver/api/v1/analyses",
      headers: {
        "Idempotency-Key": crypto.randomUUID(),
        "X-Test-User": "ri.multipass.main.user.cypress",
        "X-Test-Org": "ri.multipass.main.org.cypress",
      },
      body: { parentFolderRid: folder, displayName: "cypress-b1" },
    }).then((res) => {
      expect(res.status).to.eq(201);
      expect(res.headers["etag"]).to.match(/^W\/"[0-9a-f]{64}"$/);
      expect(res.headers["location"]).to.include("/quiver/api/v1/analyses/");
      expect(res.body.rid).to.match(
        /^ri\.tellus-quiver\.main\.analysis\.[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      rid = res.body.rid;
      etag = res.headers["etag"];
    });
  });

  it("B1 C-10 / G-03: GET returns 200 + matching ETag", () => {
    cy.request({
      url: `/quiver/api/v1/analyses/${rid}`,
      headers: { "X-Test-User": "ri.multipass.main.user.cypress" },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.headers["etag"]).to.eq(etag);
    });
  });

  it("B1 C-11 / G-03: PATCH without If-Match → 412 VersionMismatch", () => {
    cy.request({
      method: "PATCH",
      url: `/quiver/api/v1/analyses/${rid}`,
      headers: { "X-Test-User": "ri.multipass.main.user.cypress" },
      failOnStatusCode: false,
      body: { displayName: "renamed" },
    }).then((res) => {
      expect(res.status).to.eq(412);
      expect(res.body.errorName).to.eq("Tellus:Quiver:VersionMismatch");
    });
  });

  it("B1 C-12 / G-03: PATCH with current ETag returns 200 + new ETag", () => {
    cy.request({
      method: "PATCH",
      url: `/quiver/api/v1/analyses/${rid}`,
      headers: {
        "X-Test-User": "ri.multipass.main.user.cypress",
        "If-Match": etag,
      },
      body: { displayName: "renamed" },
    }).then((res) => {
      expect(res.status).to.eq(200);
      expect(res.headers["etag"]).to.not.eq(etag);
      etag = res.headers["etag"];
    });
  });

  it("B1 C-14: DELETE soft + GET → 404 AnalysisNotFound", () => {
    cy.request({
      method: "DELETE",
      url: `/quiver/api/v1/analyses/${rid}`,
      headers: {
        "X-Test-User": "ri.multipass.main.user.cypress",
        "If-Match": etag,
      },
    }).then((res) => {
      expect(res.status).to.eq(204);
    });
    cy.request({
      url: `/quiver/api/v1/analyses/${rid}`,
      headers: { "X-Test-User": "ri.multipass.main.user.cypress" },
      failOnStatusCode: false,
    }).then((res) => {
      expect(res.status).to.eq(404);
      expect(res.body.errorName).to.eq("Tellus:Quiver:AnalysisNotFound");
    });
  });

  it("G-04 / B1 C-16: missing Idempotency-Key on POST → 400", () => {
    cy.request({
      method: "POST",
      url: "/quiver/api/v1/analyses",
      headers: { "X-Test-User": "ri.multipass.main.user.cypress" },
      failOnStatusCode: false,
      body: { parentFolderRid: folder, displayName: "no-key" },
    }).then((res) => {
      expect(res.status).to.eq(400);
      expect(res.body.errorName).to.eq("Tellus:Quiver:InvalidAnalysisRequest");
    });
  });

  it("G-07: missing auth header → 401 Unauthenticated", () => {
    cy.request({
      method: "POST",
      url: "/quiver/api/v1/analyses",
      failOnStatusCode: false,
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: { parentFolderRid: folder, displayName: "anon" },
    }).then((res) => {
      expect(res.status).to.eq(401);
      expect(res.body.errorName).to.eq("Tellus:Quiver:Unauthenticated");
    });
  });
});
