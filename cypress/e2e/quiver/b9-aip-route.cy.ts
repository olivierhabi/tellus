// b9-aip-route.cy.ts — CONTRACT v1 §3 (4).
//
// Submit a real prompt to /aip/generate, assert the response is well
// shaped and the trace row is persisted. The OTel span chain assertion
// described in the contract requires reading the otel-collector's file
// exporter; that is asserted by the harness, not the spec.
//
// Auth: per decisions/quiver/D-2026-05-05-cypress-test-auth.md the verify
// stack uses the QUIVER_ALLOW_TEST_AUTH=1 bypass via x-test-user /
// x-test-org headers — Keycloak still runs (per CONTRACT §2) but is not
// in the auth path for these BE-only specs to avoid issuer-mismatch
// between localhost:32080 (cypress) and keycloak:8080 (app).

const PARENT_FOLDER = "ri.compass.main.folder.verify";
const RID_RE = /^ri\.tellus-quiver\.main\.analysis\./;

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-test-user": "ri.multipass.main.user.verify",
    "x-test-org": "ri.multipass.main.org.verify",
    ...extra,
  };
}

describe("B9 AIP route (live)", () => {
  it("generate returns 200 and trace row is persisted", () => {
    const idemKey = `b9-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cy.request({
      method: "POST",
      url: "/quiver/api/v1/analyses",
      headers: authed({ "Idempotency-Key": idemKey, "X-Tellus-Branch": "trunk" }),
      body: { parentFolderRid: PARENT_FOLDER, displayName: "b9 aip live" },
    }).then((createRes) => {
      expect(createRes.status).to.eq(201);
      const rid: string = createRes.body.rid;
      expect(rid).to.match(RID_RE);

      cy.request({
        method: "POST",
        url: "/quiver/api/v1/aip/generate",
        headers: authed({
          "X-Tellus-Branch": "trunk",
          "X-Deadline": new Date(Date.now() + 30_000).toISOString(),
          Accept: "text/event-stream",
        }),
        body: {
          analysisRid: rid,
          prompt: "Create a simple object set card from dataset 'orders'.",
          contextCardIds: [],
        },
        failOnStatusCode: false,
      }).then((res) => {
        expect(res.status).to.eq(200);
        const sseText = (
          typeof res.body === "string" ? res.body : JSON.stringify(res.body)
        ) as string;
        expect(sseText).to.match(/event: done/);
        // Extract traceRid from last `data:` line of the `done` event.
        // SSE frame: `event: done\ndata: {"traceRid":"...","surface":"GENERATE"}\n\n`
        const m = sseText.match(/event: done[\s\S]*?data: ({[\s\S]*?})\n/);
        expect(m, "done event with data payload").to.not.be.null;
        const done = JSON.parse((m as RegExpMatchArray)[1]);
        expect(done.traceRid).to.match(/^ri\.tellus-quiver\.main\.trace\./);

        cy.request({
          method: "GET",
          url: `/quiver/api/v1/aip/traces/${done.traceRid}`,
          headers: authed(),
          failOnStatusCode: false,
        }).then((tr) => {
          expect(tr.status).to.eq(200);
          expect(tr.body.rid).to.eq(done.traceRid);
          expect(tr.body.surface).to.eq("GENERATE");
        });
      });
    });
  });
});
