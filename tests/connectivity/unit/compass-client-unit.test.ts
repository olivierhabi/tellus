// ---------------------------------------------------------------------------
// Unit tests for src/services/connectivity/clients/compass.client.ts#getFolder.
//
// getFolder resolves the Compass container a connection (source) is parented
// under. It must accept ANY container the folder picker can return —
// folder / project / space — not folders only, otherwise the create path
// silently discards the user's selected location. It must still reject
// non-container or trashed resources.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Compass read service so this stays a pure unit test (no DB/pool).
vi.mock("../../../src/services/compassService", () => ({
  getResource: vi.fn(),
}));

import { getResource, type Resource } from "../../../src/services/compassService";
import { getFolder } from "../../../src/services/connectivity/clients/compass.client";
import { TellusError } from "../../../src/lib/errors/envelope";

const mockGetResource = vi.mocked(getResource);

const RID = "ri.compass.main.project.00000000-1111-2222-3333-444444444444";
const SPACE = "ri.compass.main.space.00000000-0000-0000-0000-000000000000";

function resource(overrides: Partial<Resource> = {}): Resource {
  return {
    rid: RID,
    service: "compass",
    type: "PROJECT",
    displayName: "My Project",
    description: null,
    documentation: null,
    parentFolderRid: null,
    projectRid: null,
    spaceRid: SPACE,
    trashStatus: "NOT_TRASHED",
    createdBy: "u",
    createdAt: "t",
    updatedBy: "u",
    updatedAt: "t",
    etag: 1,
    metadata: {},
    legacyUuid: null,
    ...overrides,
  } as Resource;
}

describe("compass.client getFolder (connection-parent resolver)", () => {
  beforeEach(() => {
    mockGetResource.mockReset();
  });

  it.each(["folder", "FOLDER", "COMPASS_FOLDER", "PROJECT", "COMPASS_SPACE"])(
    "accepts container type %s and returns its spaceRid",
    async (type) => {
      mockGetResource.mockResolvedValue(resource({ type }));
      const f = await getFolder(RID);
      expect(f.rid).toBe(RID);
      expect(f.spaceRid).toBe(SPACE);
    },
  );

  it("rejects a non-container resource (e.g. a source)", async () => {
    mockGetResource.mockResolvedValue(resource({ type: "source" }));
    await expect(getFolder(RID)).rejects.toBeInstanceOf(TellusError);
  });

  it("rejects a trashed container", async () => {
    mockGetResource.mockResolvedValue(
      resource({ trashStatus: "DIRECTLY_TRASHED" }),
    );
    await expect(getFolder(RID)).rejects.toBeInstanceOf(TellusError);
  });

  it("maps an unresolvable RID to CompassFolderNotFound", async () => {
    mockGetResource.mockRejectedValue(new Error("not found"));
    await expect(getFolder(RID)).rejects.toBeInstanceOf(TellusError);
  });
});
