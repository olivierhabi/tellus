// Regression coverage — Phase K (Steps 78–79).
//
// Pins the Workshop per-module grant semantics the RSSB Fraud module now
// relies on:
//   1. Group grants match caller group identifiers AFTER normalization
//      ("fraud-analyst" ≡ "fraud analyst") — the platform's pseudo-group
//      convention (realm roles double as group identifiers; the coalescing
//      of roles into `groups` happens in getModuleEffectiveRole).
//   2. Effective access is additive: the strongest applicable role wins
//      across global, direct-user, group, and default-group sources.
//   3. No grant + no roles ⇒ null (module concealed, 404 semantics).

import { describe, expect, it } from "vitest";
import {
  effectiveRoleFromInputs,
  getWorkshopDependencyAccess,
  type ModuleGrant,
} from "../../../src/services/workshop/grantService";

const grant = (
  principalType: "user" | "group",
  principalId: string,
  role: "viewer" | "editor",
): ModuleGrant => ({
  moduleRid: "ri.workshop.main.module.test",
  principalType,
  principalId,
  role,
  grantedBy: "test",
  grantedAt: new Date().toISOString(),
});

describe("getWorkshopDependencyAccess — module access stays independent", () => {
  it("allows ontology catalogue dependencies for an ontology reader", () => {
    expect(getWorkshopDependencyAccess(["ontology-viewer"])).toEqual({
      objectTypes: true,
      linkTypes: true,
      actionTypes: true,
      functions: true,
      reason: "User has ontology-viewer role",
    });
  });

  it("does not infer dependency access from a Workshop or business role", () => {
    expect(
      getWorkshopDependencyAccess(["workshop-viewer", "fraud-investigator"]),
    ).toEqual({
      objectTypes: false,
      linkTypes: false,
      actionTypes: false,
      functions: false,
      reason: "INSUFFICIENT_ONTOLOGY_READ_ROLE",
    });
  });
});

describe("effectiveRoleFromInputs — Phase K regression", () => {
  it("platform super role short-circuits to editor", () => {
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: ["tellus-superadmin"], groups: [] },
        [],
      ),
    ).toBe("editor");
  });

  it("ontology roles do not elevate Workshop module access", () => {
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: ["ontology-admin"], groups: [] },
        [],
      ),
    ).toBeNull();
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: ["ontology-editor"], groups: [] },
        [grant("user", "u1", "viewer")],
      ),
    ).toBe("viewer");
  });

  it("legacy global workshop roles resolve without grants", () => {
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: ["workshop-viewer"], groups: [] },
        [],
      ),
    ).toBe("viewer");
  });

  it("group grant matches a realm-role-style identifier after normalization", () => {
    // Stored form is normalized on write ("fraud analyst"); the caller
    // supplies the JWT claim value ("fraud-analyst") — the pseudo-group
    // convention must equate them.
    const grants = [grant("group", "fraud analyst", "viewer")];
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: [], groups: ["fraud-analyst"] },
        grants,
      ),
    ).toBe("viewer");
  });

  it("a caller without the group does NOT match the group grant", () => {
    const grants = [grant("group", "fraud analyst", "viewer")];
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: [], groups: ["someone-else"] },
        grants,
      ),
    ).toBeNull();
  });

  it("a group Editor grant is not downgraded by a direct Viewer grant", () => {
    const grants = [
      grant("group", "fraud analyst", "editor"),
      grant("user", "u1", "viewer"),
    ];
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: [], groups: ["fraud-analyst"] },
        grants,
      ),
    ).toBe("editor");
  });

  it("a global Viewer role is elevated by a module-specific Editor grant", () => {
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: ["workshop-viewer"], groups: [] },
        [grant("user", "u1", "editor")],
      ),
    ).toBe("editor");
  });

  it("a direct Editor grant is not downgraded by a Viewer group grant", () => {
    const grants = [
      grant("group", "fraud analyst", "viewer"),
      grant("user", "u1", "editor"),
    ];
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: [], groups: ["fraud-analyst"] },
        grants,
      ),
    ).toBe("editor");
  });

  it("editor group grant beats viewer group grant", () => {
    const grants = [
      grant("group", "fraud analyst", "viewer"),
      grant("group", "workshop builders", "editor"),
    ];
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: [], groups: ["fraud-analyst", "Workshop Builders"] },
        grants,
      ),
    ).toBe("editor");
  });

  it("default groups apply when no explicit grant matches", () => {
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: [], groups: ["Workshop Users"] },
        [],
      ),
    ).toBe("viewer");
  });

  it("no roles, no groups, no grants ⇒ null (concealed)", () => {
    expect(
      effectiveRoleFromInputs({ userId: "u1", roles: [], groups: [] }, []),
    ).toBeNull();
  });
});
