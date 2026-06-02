// ---------------------------------------------------------------------------
// Unit tests for src/services/connectivity/principalNames.ts.
//
// Resolves Keycloak subject IDs (connectivity created_by / updated_by) into
// display names. Verifies name composition, caching, dedup, negative caching
// of confirmed-absent principals, and the resilience contract: transient
// Keycloak failures must NOT be cached.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

const getUserById = vi.fn();

vi.mock("../../../src/services/keycloakAdminService", () => ({
  getKeycloakAdminService: () => ({ getUserById }),
}));

import {
  resolvePrincipalNames,
  __clearPrincipalNameCacheForTest,
} from "../../../src/services/connectivity/principalNames";

function kcUser(over: Partial<{
  id: string;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}> = {}) {
  return {
    id: "id",
    username: "user@x.io",
    email: "user@x.io",
    firstName: null,
    lastName: null,
    ...over,
  };
}

beforeEach(() => {
  getUserById.mockReset();
  __clearPrincipalNameCacheForTest();
});

describe("resolvePrincipalNames — composition", () => {
  it('composes "First Last" when both present', async () => {
    getUserById.mockResolvedValue(kcUser({ firstName: "Connor", lastName: "Orzen" }));
    const m = await resolvePrincipalNames(["a"]);
    expect(m.get("a")).toBe("Connor Orzen");
  });

  it("falls back to username, then email, when names are absent", async () => {
    getUserById.mockResolvedValueOnce(kcUser({ username: "connor", email: "c@x.io" }));
    expect((await resolvePrincipalNames(["a"])).get("a")).toBe("connor");

    __clearPrincipalNameCacheForTest();
    getUserById.mockResolvedValueOnce(
      kcUser({ username: "", email: "c@x.io" }) as never,
    );
    expect((await resolvePrincipalNames(["b"])).get("b")).toBe("c@x.io");
  });
});

describe("resolvePrincipalNames — caching & dedup", () => {
  it("dedups duplicate ids and resolves each id once per window", async () => {
    getUserById.mockResolvedValue(kcUser({ firstName: "A", lastName: "B" }));
    await resolvePrincipalNames(["a", "a", "a"]);
    expect(getUserById).toHaveBeenCalledTimes(1);
  });

  it("serves the second call from cache (no re-fetch)", async () => {
    getUserById.mockResolvedValue(kcUser({ firstName: "A", lastName: "B" }));
    await resolvePrincipalNames(["a"]);
    await resolvePrincipalNames(["a"]);
    expect(getUserById).toHaveBeenCalledTimes(1);
  });

  it("negatively caches a CONFIRMED-absent principal (404 → null)", async () => {
    getUserById.mockResolvedValue(null); // getUserById maps 404 → null
    expect((await resolvePrincipalNames(["gone"])).get("gone")).toBeNull();
    expect((await resolvePrincipalNames(["gone"])).get("gone")).toBeNull();
    // Confirmed-absent is cached: only one lookup despite two calls.
    expect(getUserById).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePrincipalNames — resilience", () => {
  it("returns null on a transient failure and does NOT cache it", async () => {
    getUserById.mockRejectedValueOnce(new Error("Keycloak unreachable"));
    expect((await resolvePrincipalNames(["a"])).get("a")).toBeNull();

    // Keycloak recovers — the next call must retry (not serve a cached null).
    getUserById.mockResolvedValueOnce(kcUser({ firstName: "Connor", lastName: "Orzen" }));
    expect((await resolvePrincipalNames(["a"])).get("a")).toBe("Connor Orzen");
    expect(getUserById).toHaveBeenCalledTimes(2);
  });

  it("never throws even if every lookup fails", async () => {
    getUserById.mockRejectedValue(new Error("down"));
    const m = await resolvePrincipalNames(["a", "b"]);
    expect(m.get("a")).toBeNull();
    expect(m.get("b")).toBeNull();
  });

  it("ignores empty / falsy ids", async () => {
    getUserById.mockResolvedValue(kcUser({ firstName: "A", lastName: "B" }));
    const m = await resolvePrincipalNames(["", "a"]);
    expect(m.has("")).toBe(false);
    expect(m.get("a")).toBe("A B");
    expect(getUserById).toHaveBeenCalledTimes(1);
  });
});
