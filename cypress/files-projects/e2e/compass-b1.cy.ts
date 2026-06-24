// Cypress E2E for Files & Projects B1 — Compass Resource Model & RID System.
//
// Per D-14, the runner stays gated on CYPRESS_BIN. In CI, the project boots
// the API server (npm run dev) against the test Postgres, then Cypress runs
// against http://127.0.0.1:4000.
//
// Each it() block is annotated with the contract IDs it exercises:
//   B1-C-24  — same-transaction resources-row materialization on POST /projects
//   B1-C-24  — same-transaction resources-row materialization on POST /folders
//   B1-C-30  — RESOURCE_NOT_FOUND envelope shape (via the integration test;
//               B1 exposes no GET-by-rid HTTP route until B3, so the surface
//               is white-box in B1)
//
// The compass-internal surfaces (getResource / getResourcesBatch / getResourceByPath)
// are exercised by tests/foundry/integration/compass-b1-integration.test.ts
// against the same live Postgres stack — see PROGRESS.md.

const SUITE = `cypress-b1-${Date.now()}`;
const ALICE_HEADERS = {
  "X-Test-User": "ri.multipass.main.user.alice",
  "X-Test-Org": "ri.multipass.main.org.cypress",
};

describe("Files & Projects B1 — Compass resources side-effects via HTTP", () => {
  let projectId = "";
  let folderId = "";

  it("B1-C-24: POST /projects creates the project (resources row materialized server-side in same txn)", () => {
    cy.request({
      method: "POST",
      url: "/api/projects",
      headers: ALICE_HEADERS,
      body: { name: `${SUITE}-project` },
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 201]);
      expect(res.body).to.have.property("id");
      expect(res.body).to.have.property("name", `${SUITE}-project`);
      projectId = res.body.id as string;
      // The resources row keyed by legacy_uuid=projectId is asserted by the
      // integration test against live Postgres. Cypress sees only the HTTP
      // layer; the same-txn invariant is contractual (B1-C-24) and covered
      // by the green/red/green triplet in scripts/b1-c24-proof.ts.
    });
  });

  it("B1-C-24: POST /folders creates a folder under the project", () => {
    expect(projectId, "createProject must succeed first").to.not.eq("");
    cy.request({
      method: "POST",
      url: "/api/folders",
      headers: ALICE_HEADERS,
      body: { project_id: projectId, name: `${SUITE}-folder`, parent_folder_id: null },
    }).then((res) => {
      expect(res.status).to.be.oneOf([200, 201]);
      expect(res.body).to.have.property("id");
      expect(res.body).to.have.property("project_id", projectId);
      folderId = res.body.id as string;
    });
  });

  it("B1-C-24: GET /projects/:id/folders shows the new folder (resources tree consistent with legacy tree)", () => {
    expect(projectId, "createProject must succeed first").to.not.eq("");
    cy.request({
      method: "GET",
      url: `/api/projects/${projectId}/folders`,
      headers: ALICE_HEADERS,
    }).then((res) => {
      expect(res.status).to.eq(200);
      const ids = (res.body as Array<{ id: string }>).map((f) => f.id);
      expect(ids).to.include(folderId);
    });
  });

  // Cleanup so re-runs are deterministic.
  after(() => {
    if (projectId) {
      cy.request({
        method: "DELETE",
        url: `/api/projects/${projectId}`,
        headers: ALICE_HEADERS,
        failOnStatusCode: false,
      });
    }
  });
});
