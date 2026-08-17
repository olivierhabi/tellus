// ---------------------------------------------------------------------------
// adminRolesService.directory-unit.test.ts — GET /api/v1/auth/roles backing
// service (listRoleDirectory).
//
// The directory exists so NON-superadmin authoring surfaces (Ontology Manager
// submission criteria) can offer a role picker without reading the superadmin
// console. Its contract differs from listRoles() on purpose:
//   1. Shape is id + name + description ONLY — no member counts, no composite
//      edges (those stay behind requireSuperAdmin).
//   2. No N+1 hydration — a single paged Keycloak read per call.
//   3. Built-in realm roles are INCLUDED: a criterion on
//      `default-roles-tellus` ("any authenticated user") is legitimate, and
//      the directory must round-trip every name a picker can encounter.
//
// Run: npx vitest run --config vitest.unit.config.ts <this-file>
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listRoles: vi.fn(),
}));

vi.mock("../../../src/services/keycloakAdminService", () => ({
  getKeycloakAdminService: () => ({ listRoles: mocks.listRoles }),
  KeycloakRealmRole: class {},
}));

import { getAdminRolesService } from "../../../src/services/adminRolesService";

describe("AdminRolesService.listRoleDirectory", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns id + name + description for every realm role, sorted by name", async () => {
    mocks.listRoles.mockResolvedValue([
      { id: "2", name: "tellus-superadmin" },
      { id: "1", name: "credit-analyst", description: "Approves credit" },
    ]);
    const roles = await getAdminRolesService().listRoleDirectory();
    expect(roles).toEqual([
      { id: "1", name: "credit-analyst", description: "Approves credit" },
      { id: "2", name: "tellus-superadmin", description: "" },
    ]);
  });

  it("includes built-in realm roles (round-trip fidelity for existing criteria)", async () => {
    mocks.listRoles.mockResolvedValue([
      { id: "a", name: "default-roles-tellus", composite: true },
      { id: "b", name: "offline_access" },
    ]);
    const roles = await getAdminRolesService().listRoleDirectory();
    expect(roles.map((r) => r.name)).toEqual([
      "default-roles-tellus",
      "offline_access",
    ]);
  });

  it("pages through Keycloak in 200-row chunks until a short page", async () => {
    mocks.listRoles
      .mockResolvedValueOnce(
        Array.from({ length: 200 }, (_, i) => ({
          id: `id-${i}`,
          name: `role-${String(i).padStart(3, "0")}`,
        })),
      )
      .mockResolvedValueOnce([{ id: "id-200", name: "role-200" }]);
    const roles = await getAdminRolesService().listRoleDirectory();
    expect(roles).toHaveLength(201);
    expect(mocks.listRoles).toHaveBeenNthCalledWith(1, { first: 0, max: 200 });
    expect(mocks.listRoles).toHaveBeenNthCalledWith(2, { first: 200, max: 200 });
  });

  it("drops malformed rows missing id or name (a picker value must always be a real name)", async () => {
    mocks.listRoles.mockResolvedValue([
      { id: "1", name: "credit-analyst" },
      { id: "", name: "no-id" },
      { id: "2", name: "" },
    ]);
    const roles = await getAdminRolesService().listRoleDirectory();
    expect(roles).toEqual([{ id: "1", name: "credit-analyst", description: "" }]);
  });
});
