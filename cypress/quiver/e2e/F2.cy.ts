/// <reference types="cypress" />
// Quiver F2 — branch dispatch surface (cypress smoke).
// Covers: F2 C-10.

describe("F2 — branch indicator on dispatch", () => {
  const headers = {
    "x-test-user": "ri.multipass.main.user.cy-f2",
    "x-test-org": "ri.multipass.main.org.cy-f2",
  };

  it("F2 C-10: POST + LIST agree on the branch the FE store stamped", () => {
    const folder = "ri.compass.main.folder.cy-f2";
    const branch = `cy-f2-${Date.now().toString(36).slice(-8)}`;
    cy.request({
      method: "POST",
      url: `/quiver/api/v1/analyses`,
      headers: { ...headers, "idempotency-key": crypto.randomUUID(), "x-tellus-branch": branch },
      body: { displayName: `cy f2`, parentFolderRid: folder },
    }).then((created) => {
      expect(created.status).to.equal(201);
      cy.request({
        method: "GET",
        url: `/quiver/api/v1/folders/${encodeURIComponent(folder)}/analyses`,
        headers: { ...headers, "x-tellus-branch": branch },
      }).then((list) => {
        expect(list.body.items.find((i: { rid: string }) => i.rid === created.body.rid)).to.exist;
      });
    });
  });
});
