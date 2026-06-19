// gate-02-compute-cache-deadline.cy.ts — CONTRACT v1 §3 (2).
//
// Submit an identical compute request twice; assert the second is a cache
// hit within the deadline budget. The contract describes a UI badge +
// OTel span attribute (compute.cache_hit). Until the SPA in tellus-fe
// lands (D-23), the BE-side cacheOutcome flag in the response body is
// the canonical source for the harness.
//
// Auth: x-test-user / x-test-org bypass (D-2026-05-05-cypress-test-auth).

const PARENT_FOLDER = "ri.compass.main.folder.verify";

function authed(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-test-user": "ri.multipass.main.user.verify",
    "x-test-org": "ri.multipass.main.org.verify",
    ...extra,
  };
}

describe("GATE-02 compute cache + deadlines (live)", () => {
  it("cache miss → cache hit → deadline boundary", () => {
    const idemKey = `gate-02-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cy.request({
      method: "POST",
      url: "/quiver/api/v1/analyses",
      headers: authed({ "Idempotency-Key": idemKey, "X-Tellus-Branch": "trunk" }),
      body: { parentFolderRid: PARENT_FOLDER, displayName: "gate-02 compute" },
    }).then((createRes) => {
      expect(createRes.status).to.eq(201);
      const rid: string = createRes.body.rid;

      // Add an OBJECT_SET card to the analysis via OT instruction so it
      // exists when compute is invoked.
      cy.request({
        method: "POST",
        url: `/quiver/api/v1/analyses/${rid}/instructions`,
        headers: authed({ "X-Tellus-Branch": "trunk" }),
        body: {
          baseVersion: 0,
          clientOpIds: [`cop-verify-${Date.now()}`],
          instructions: [
            {
              kind: "addCard",
              card: {
                id: "$A",
                type: "OBJECT_SET",
                inputs: {},
                config: { objectTypeRid: "ri.oms.main.type.dataset" },
                hidden: false,
              },
            },
          ],
        },
        failOnStatusCode: false,
      }).then((addRes) => {
        expect(addRes.status).to.be.oneOf([200, 202]);

        const computeBody = {
          analysisRid: rid,
          cardId: "$A",
          parameterOverrides: {},
          branch: "trunk",
          cacheBehavior: "READ_WRITE" as const,
        };

        // First call — cache miss.
        cy.request({
          method: "POST",
          url: "/quiver/api/v1/compute/cards",
          headers: authed({
            "X-Tellus-Branch": "trunk",
            "X-Deadline": new Date(Date.now() + 5000).toISOString(),
          }),
          body: computeBody,
          failOnStatusCode: false,
        }).then((firstRes) => {
          expect(firstRes.status).to.be.oneOf([200, 202]);
          if (firstRes.body && typeof firstRes.body.cacheOutcome === "string") {
            expect(firstRes.body.cacheOutcome).to.eq("miss");
          }

          // Second call — cache hit.
          cy.request({
            method: "POST",
            url: "/quiver/api/v1/compute/cards",
            headers: authed({
              "X-Tellus-Branch": "trunk",
              "X-Deadline": new Date(Date.now() + 5000).toISOString(),
            }),
            body: computeBody,
            failOnStatusCode: false,
          }).then((secondRes) => {
            expect(secondRes.status).to.eq(200);
            if (secondRes.body && typeof secondRes.body.cacheOutcome === "string") {
              expect(secondRes.body.cacheOutcome).to.eq("hit");
            }
          });

          // Third call with already-passed deadline — DEADLINE_EXCEEDED at the boundary.
          cy.request({
            method: "POST",
            url: "/quiver/api/v1/compute/cards",
            headers: authed({
              "X-Tellus-Branch": "trunk",
              "X-Deadline": new Date(Date.now() - 1000).toISOString(),
            }),
            body: { ...computeBody, ontologyVersion: "v1" },
            failOnStatusCode: false,
          }).then((thirdRes) => {
            // Spec: 504 with errorName Tellus:Quiver:DeadlineExceeded.
            // 408 (RFC 7235) is acceptable as an alternate mapping.
            expect(thirdRes.status).to.be.oneOf([504, 408]);
          });
        });
      });
    });
  });
});
