// B8 — Time-Series Backend (Codex) — live-API HTTP smokes.
// FE convergence smokes live in tellus-fe (per D-23).

describe("B8 — TIME_SERIES backend route surface", () => {
  it("B8 C-09: GET /compute/timeseries/<unknown-token> → 410 HydrationTokenExpired", () => {
    cy.request({
      method: "GET",
      url: "/quiver/api/v1/compute/timeseries/tok_does_not_exist",
      failOnStatusCode: false,
      headers: { Authorization: "Bearer test:smoke" },
    }).then((res) => {
      expect(res.status).to.eq(410);
      expect(res.body.errorName).to.eq("Tellus:Quiver:HydrationTokenExpired");
    });
  });
});
