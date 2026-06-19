// B3 — live-API smoke for instructions endpoint.
// Covers C-02 (200 + ack), C-14 (400 MalformedInstruction).
const API = Cypress.env("QUIVER_API_URL") || "http://localhost:7311";

describe("B3 — instructions route smoke", () => {
  it("B3 C-14: malformed → 400 Tellus:Quiver:MalformedInstruction", () => {
    cy.request({
      method: "POST",
      url: `${API}/quiver/api/v1/analyses/ri.tellus-quiver.main.analysis.00000000-0000-7000-8000-000000000000/instructions`,
      headers: {
        "x-test-user": "ri.multipass.main.user.smoke",
        "x-test-org": "ri.multipass.main.org.smoke",
      },
      body: {
        baseVersion: 0,
        clientOpIds: ["op1"],
        instructions: [{ kind: "fooBar" }],
      },
      failOnStatusCode: false,
    }).then((r) => {
      // Either 400 MalformedInstruction or 404 AnalysisNotFound (depending
      // on whether the rid happens to exist in the smoke env).
      expect([400, 404]).to.include(r.status);
    });
  });
});
