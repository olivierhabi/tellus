// ---------------------------------------------------------------------------
// compass.client — FK-safe user resolution + missing-resources self-heal.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the low-level pool so no live DB is needed.
const mockQuery = vi.fn();
const mockClient = { query: mockQuery } as unknown as import("pg").PoolClient;

// We import after mocking to avoid side-effects.
import {
  registerConnectionResource,
  unregisterConnectionResource,
  renameConnectionResource,
  ensureSystemUser,
  repairMissingResources,
} from "../../../src/services/connectivity/clients/compass.client";

const VALID_USER = "8f02d2de-6353-4195-bf94-bc7626484bd0";
const SYNTHETIC_USER = "6d387e7e-89ed-45b0-9b8f-4d27bd834d97";
const FIRST_USER = "4f0becdd-db36-4b81-9aee-45491cd000cd";
const SYSTEM_FALLBACK = "00000000-0000-0000-0000-000000000001";

describe("compass.client — FK-safe user resolution", () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it("uses candidate directly when it exists in users", async () => {
    // First query: hit for candidate, fallback not called
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: VALID_USER }] } as never) // hit
      .mockResolvedValueOnce({ rows: [] } as never); // INSERT (no return)

    await registerConnectionResource(mockClient, {
      rid: "ri.magritte.main.source.test",
      displayName: "test",
      description: "",
      parentFolderRid: "ri.compass.main.project.36271681-65d7-4c55-a6d0-20137f8212dc",
      spaceRid: "ri.compass.main.space.00000000-0000-0000-0000-000000000000",
      createdBy: VALID_USER,
      metadata: {},
    });

    // First call was the hit check
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SELECT id FROM users WHERE id = $1::uuid"),
      [VALID_USER],
    );
    // Second call was the INSERT with validCreatedBy = VALID_USER
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[1][5]).toBe(VALID_USER);
  });

  it("falls back to first user when candidate is synthetic and not in users", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as never) // miss for synthetic
      .mockResolvedValueOnce({ rows: [{ id: FIRST_USER }] } as never) // fallback
      .mockResolvedValueOnce({ rows: [] } as never); // INSERT

    await registerConnectionResource(mockClient, {
      rid: "ri.magritte.main.source.test2",
      displayName: "test2",
      description: "",
      parentFolderRid: "ri.compass.main.project.36271681-65d7-4c55-a6d0-20137f8212dc",
      spaceRid: "ri.compass.main.space.00000000-0000-0000-0000-000000000000",
      createdBy: SYNTHETIC_USER,
      metadata: {},
    });

    const insertCall = mockQuery.mock.calls[2];
    expect(insertCall[1][5]).toBe(FIRST_USER);
  });

  it("falls back for non-UUID candidate like 'system'", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: FIRST_USER }] } as never) // fallback
      .mockResolvedValueOnce({ rows: [] } as never); // INSERT

    await registerConnectionResource(mockClient, {
      rid: "ri.magritte.main.source.test3",
      displayName: "test3",
      description: "",
      parentFolderRid: "ri.compass.main.project.36271681-65d7-4c55-a6d0-20137f8212dc",
      spaceRid: "ri.compass.main.space.00000000-0000-0000-0000-000000000000",
      createdBy: "system",
      metadata: {},
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[1][5]).toBe(FIRST_USER);
  });

  it("unregister uses fallback for deletedBy", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as never) // miss
      .mockResolvedValueOnce({ rows: [{ id: FIRST_USER }] } as never) // fallback
      .mockResolvedValueOnce({ rows: [] } as never); // UPDATE

    await unregisterConnectionResource(mockClient, "ri.magritte.main.source.x", SYNTHETIC_USER);
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[1][1]).toBe(FIRST_USER);
  });

  it("rename uses fallback for updatedBy", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ id: FIRST_USER }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    await renameConnectionResource(mockClient, "ri.magritte.main.source.x", "newName", SYNTHETIC_USER);
    const updateCall = mockQuery.mock.calls[2];
    expect(updateCall[1][2]).toBe(FIRST_USER);
  });
});

describe("compass.client — ensureSystemUser", () => {
  beforeEach(() => mockQuery.mockReset());

  it("returns existing system user when present", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: SYSTEM_FALLBACK }] } as never);
    const id = await ensureSystemUser(mockClient);
    expect(id).toBe(SYSTEM_FALLBACK);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("reuses first user when table not empty and system missing", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as never) // system missing
      .mockResolvedValueOnce({ rows: [{ id: FIRST_USER }] } as never); // first user
    const id = await ensureSystemUser(mockClient);
    expect(id).toBe(FIRST_USER);
  });

  it("inserts system user when table empty", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] } as never) // system missing
      .mockResolvedValueOnce({ rows: [] } as never) // first user missing
      .mockResolvedValueOnce({ rows: [] } as never); // INSERT
    const id = await ensureSystemUser(mockClient);
    expect(id).toBe(SYSTEM_FALLBACK);
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });
});

describe("compass.client — repairMissingResources", () => {
  beforeEach(() => mockQuery.mockReset());

  it("inserts missing resources for connectivity_connections without resources row", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 5 } as never);
    const count = await repairMissingResources(mockClient);
    expect(count).toBe(5);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO resources"),
    );
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM resources r WHERE r.rid = cc.rid)");
    expect(sql).toContain("CASE WHEN cc.deleted_at IS NOT NULL THEN 'DIRECTLY_TRASHED'");
  });
});
