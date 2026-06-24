// B9 — AIP route surface — live-API HTTP smokes.

describe("B9 — AIP route surface", () => {
  it("B9 C-09: GET /aip/traces/<unknown> → 404 TraceNotFound", () => {
    cy.request({
      method: "GET",
      url: "/quiver/api/v1/aip/traces/ri.tellus-quiver.main.trace.00000000-0000-7000-8000-000000000000",
      failOnStatusCode: false,
      headers: { Authorization: "Bearer test:smoke" },
    }).then((res) => {
      expect(res.status).to.eq(404);
      expect(res.body.errorName).to.eq("Tellus:Quiver:TraceNotFound");
    });
  });

  it("B9 C-06: missing auth on /aip/generate → 401", () => {
    cy.request({
      method: "POST",
      url: "/quiver/api/v1/aip/generate",
      failOnStatusCode: false,
      body: { analysisRid: "x", prompt: "x" },
    }).then((res) => {
      expect(res.status).to.eq(401);
    });
  });
});
