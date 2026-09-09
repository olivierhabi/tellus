// Regression coverage — Phase K (Steps 78–79).
//
// Pins the Workshop per-module grant semantics the RSSB Fraud module now
// relies on:
//   1. Group grants match caller group identifiers AFTER normalization
//      ("fraud-analyst" ≡ "fraud analyst") — the platform's pseudo-group
//      convention (realm roles double as group identifiers; the coalescing
//      of roles into `groups` happens in getModuleEffectiveRole).
//   2. Resolution precedence: super/global roles → direct user grant →
//      group grant → default groups → null.
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
  it("super roles short-circuit to editor", () => {
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: ["ontology-admin"], groups: [] },
        [],
      ),
    ).toBe("editor");
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: ["ontology-editor"], groups: [] },
        [],
      ),
    ).toBe("editor");
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

  it("direct user grant wins over group grant", () => {
    const grants = [
      grant("group", "fraud analyst", "editor"),
      grant("user", "u1", "viewer"),
    ];
    expect(
      effectiveRoleFromInputs(
        { userId: "u1", roles: [], groups: ["fraud-analyst"] },
        grants,
      ),
    ).toBe("viewer");
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
