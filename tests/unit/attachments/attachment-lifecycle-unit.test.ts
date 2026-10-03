import { beforeEach, describe, expect, it, vi } from "vitest";

const { query, deleteObjects } = vi.hoisted(() => ({
  query: vi.fn(),
  deleteObjects: vi.fn(),
}));

vi.mock("../../../src/db", () => ({ query }));
vi.mock("../../../src/services/storageService", () => ({
  uploadObject: vi.fn(),
  getObjectStream: vi.fn(),
  deleteObjects,
}));

import {
  ATTACHMENT_MAX_LINKED_OBJECTS,
  collectAttachmentRidsFromEdits,
  extractAttachmentRids,
  stampAttachmentsLinked,
  sweepUnlinkedAttachments,
  verifyAttachmentReferences,
} from "../../../src/services/attachmentService";

const RID = "ri.attachments.main.attachment.3d2f0bd5-4d6d-455a-9ef7-033367f59d89";
const RID2 = "ri.attachments.main.attachment.101193b9-f981-45a1-b8e4-23bbdd0060e2";

describe("extractAttachmentRids", () => {
  it("finds attachment RIDs in nested property values and ignores the rest", () => {
    const found = extractAttachmentRids({
      mediaRid: RID,
      title: "Invoice Document",
      evidenceId: "EVD-1",
      nested: { list: [RID2, "ri.attachments.main.attachment.not-a-uuid", 42, null] },
    });
    expect([...found].sort()).toEqual([RID, RID2].sort());
  });
});

describe("collectAttachmentRidsFromEdits", () => {
  it("scans compiled edits and dedupes", () => {
    expect(
      collectAttachmentRidsFromEdits([
        { propertyValues: { mediaRid: RID, title: "a" } },
        { propertyValues: { mediaRid: RID, file: RID2 } },
        { propertyValues: null },
      ]).sort(),
    ).toEqual([RID, RID2].sort());
  });
});

describe("verifyAttachmentReferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports missing RIDs and over-linked ones (Foundry 10-object cap)", async () => {
    query.mockResolvedValueOnce({
      rows: [
        { rid: RID, links: 3 },
        { rid: RID2, links: ATTACHMENT_MAX_LINKED_OBJECTS },
      ],
    });
    const check = await verifyAttachmentReferences([
      RID,
      RID2,
      "ri.attachments.main.attachment.00000000-0000-0000-0000-000000000000",
    ]);
    expect(check.missing).toEqual([
      "ri.attachments.main.attachment.00000000-0000-0000-0000-000000000000",
    ]);
    expect(check.overLinked).toEqual([
      { rid: RID2, linkedObjects: ATTACHMENT_MAX_LINKED_OBJECTS },
    ]);
  });

  it("passes clean references", async () => {
    query.mockResolvedValueOnce({ rows: [{ rid: RID, links: 1 }] });
    await expect(verifyAttachmentReferences([RID])).resolves.toEqual({
      missing: [],
      overLinked: [],
    });
  });
});

describe("stampAttachmentsLinked", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stamps linked_at once per apply", async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await expect(
      stampAttachmentsLinked([RID, RID], "00000000-0000-0000-0000-000000000001"),
    ).resolves.toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1][0]).toEqual([RID]);
  });
});

describe("sweepUnlinkedAttachments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dry-run reports candidates without deleting", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ rid: RID, storage_key: "attachments/x" }] })
      .mockResolvedValueOnce({ rows: [] });
    const result = await sweepUnlinkedAttachments({ dryRun: true });
    expect(result).toMatchObject({ scanned: 1, swept: 0, dryRun: true });
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it("skips uploads still referenced by object instances", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ rid: RID, storage_key: "attachments/x" }] })
      .mockResolvedValueOnce({ rows: [{ rid: RID }] });
    const result = await sweepUnlinkedAttachments({ dryRun: false });
    expect(result).toMatchObject({ scanned: 1, swept: 0 });
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it("deletes blobs then rows for truly orphaned uploads", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ rid: RID, storage_key: "attachments/x" }] })
      .mockResolvedValueOnce({ rows: [] });
    deleteObjects.mockResolvedValueOnce({ deleted: 1, errors: 0 });
    query.mockResolvedValueOnce({ rowCount: 1 });
    const result = await sweepUnlinkedAttachments({ dryRun: false });
    expect(result).toMatchObject({ scanned: 1, swept: 1, blobsDeleted: 1 });
    expect(deleteObjects).toHaveBeenCalledWith(["attachments/x"]);
  });
});
