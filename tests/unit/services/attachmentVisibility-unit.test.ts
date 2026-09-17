/**
 * Finding A (IDOR) — attachment visibility resolver.
 *
 * Pins the access rule introduced in src/services/attachmentService.ts:
 *
 *   1. The UPLOADER (attachment.created_by === security.userId) may always
 *      access, even when the attachment is unlinked.
 *   2. Anyone else may access only when the attachment is linked to an
 *      object they can READ through executeGetObject with their security
 *      filter (the same pattern commentService.requireReadableParent uses).
 *   3. Unlinked attachments and unknown rids are uploader-only (fail-closed).
 *   4. A readability lookup error denies (fail-closed, never leak).
 *   5. Batch resolution shares object-readability lookups across rids.
 *
 * Denials are indistinguishable from "not found" at the route (404) — the
 * resolver returning an empty set is the mechanism, pinned here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const getObjectSpy = vi.fn();

vi.mock("../../../src/db", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

vi.mock("../../../src/services/queryExecutor", () => ({
  executeGetObject: (...args: unknown[]) => getObjectSpy(...args),
}));

vi.mock("../../../src/services/storageService", () => ({
  uploadObject: vi.fn(),
  getObjectStream: vi.fn(async () => null),
}));

// rid -> created_by (contents of the attachment table)
const ATTACH: Record<string, string> = {
  "ri.a.up": "reader-1", // reader's own upload
  "ri.a.unl": "other-user", // someone else's, never linked
  "ri.a.lnk": "other-user", // linked to a readable object
  "ri.a.lnk2": "other-user", // linked to the SAME readable object (cache test)
  "ri.a.lnkno": "other-user", // linked to an UNreadable object
  "ri.a.up2": "reader-1", // uploader AND linked — uploader rule short-circuits
};

// Which object instances reference each rid (action linkage).
const LINKS: Record<string, Array<[string, string]>> = {
  "ri.a.lnk": [["VerifyTaxpayer", "pk-1"]],
  "ri.a.lnk2": [["VerifyTaxpayer", "pk-1"]],
  "ri.a.lnkno": [["SecretType", "pk-9"]],
  "ri.a.up2": [["VerifyTaxpayer", "pk-1"]],
};

const SECURITY = {
  userId: "reader-1",
  markings: ["PUBLIC"],
  organizations: [],
  cbac: [],
  markingMode: "disjunctive",
  systemPrincipal: false,
  markingBypass: false,
} as const;

function wireQuery(): void {
  queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("FROM attachment")) {
      const rids = params[0] as string[];
      return {
        rows: rids
          .filter((r) => r in ATTACH)
          .map((r) => ({ rid: r, created_by: ATTACH[r] })),
      };
    }
    if (sql.includes("FROM object_instances")) {
      const rid = params[0] as string;
      return { rows: (LINKS[rid] ?? []).map(([ot, pk]) => ({ ot, pk })) };
    }
    return { rows: [] };
  });
}

// Only VerifyTaxpayer/pk-1 is readable by this principal.
function wireObjects(): void {
  getObjectSpy.mockImplementation(async (ot: string, pk: string) =>
    ot === "VerifyTaxpayer" && pk === "pk-1" ? { __pk: pk } : null,
  );
}

const importSvc = () => import("../../../src/services/attachmentService");

beforeEach(() => {
  queryMock.mockReset();
  getObjectSpy.mockReset();
  wireQuery();
  wireObjects();
});

describe("resolveAccessibleAttachmentRids — Finding A rule", () => {
  const ALL_RIDS = [
    "ri.a.up",
    "ri.a.unl",
    "ri.a.lnk",
    "ri.a.lnk2",
    "ri.a.lnkno",
    "ri.a.up2",
    "ri.a.unknown",
  ];

  it("uploader always allowed; non-uploader needs a READABLE linked object", async () => {
    const { resolveAccessibleAttachmentRids } = await importSvc();
    const visible = await resolveAccessibleAttachmentRids(ALL_RIDS, SECURITY as any);
    expect(visible).toEqual(new Set(["ri.a.up", "ri.a.lnk", "ri.a.lnk2", "ri.a.up2"]));
  });

  it("unlinked attachments are uploader-only", async () => {
    const { resolveAccessibleAttachmentRids } = await importSvc();
    const visible = await resolveAccessibleAttachmentRids(["ri.a.unl"], SECURITY as any);
    expect(visible.size).toBe(0);
  });

  it("an unreadable linked object does not grant access", async () => {
    const { resolveAccessibleAttachmentRids } = await importSvc();
    const visible = await resolveAccessibleAttachmentRids(["ri.a.lnkno"], SECURITY as any);
    expect(visible.size).toBe(0);
  });

  it("unknown rids fail closed (no existence oracle)", async () => {
    const { resolveAccessibleAttachmentRids } = await importSvc();
    const visible = await resolveAccessibleAttachmentRids(["ri.a.unknown"], SECURITY as any);
    expect(visible.size).toBe(0);
  });

  it("uploader rule short-circuits: no object lookup for own uploads", async () => {
    const { resolveAccessibleAttachmentRids } = await importSvc();
    const visible = await resolveAccessibleAttachmentRids(["ri.a.up2"], SECURITY as any);
    expect(visible.has("ri.a.up2")).toBe(true);
    const linkageProbes = queryMock.mock.calls.filter(
      ([sql, params]) =>
        String(sql).includes("FROM object_instances") && (params as unknown[])[0] === "ri.a.up2",
    );
    expect(linkageProbes).toHaveLength(0);
  });

  it("object readability is resolved ONCE per object across a batch", async () => {
    const { resolveAccessibleAttachmentRids } = await importSvc();
    await resolveAccessibleAttachmentRids(["ri.a.lnk", "ri.a.lnk2"], SECURITY as any);
    expect(getObjectSpy).toHaveBeenCalledTimes(1);
    expect(getObjectSpy).toHaveBeenCalledWith("VerifyTaxpayer", "pk-1", expect.anything(), null);
  });

  it("a readability error denies rather than leaks", async () => {
    getObjectSpy.mockRejectedValueOnce(new Error("opensearch down"));
    const { resolveAccessibleAttachmentRids } = await importSvc();
    const visible = await resolveAccessibleAttachmentRids(["ri.a.lnk"], SECURITY as any);
    expect(visible.size).toBe(0);
  });
});

describe("getAttachmentContent — denial equals not-found", () => {
  it("returns null for both denied and nonexistent attachments", async () => {
    const { getAttachmentContent } = await importSvc();
    const denied = await getAttachmentContent("ri.a.unl", SECURITY as any);
    const nonexistent = await getAttachmentContent("ri.a.unknown", SECURITY as any);
    expect(denied).toBeNull();
    expect(nonexistent).toBeNull(); // identical outcome — no existence oracle
  });
});

// --- commentService.listComments: reader-inaccessible attachments omitted ---

const workshopQueryMock = vi.fn();

vi.mock("../../../src/services/workshop/db", () => ({
  getWorkshopDb: () => ({ query: (...args: unknown[]) => workshopQueryMock(...args) }),
}));

vi.mock("../../../src/models/notificationInbox", () => ({
  insertNotification: vi.fn(),
}));

function wireWorkshopDb(): void {
  workshopQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM comment_thread")) {
      return { rows: [{ thread_id: "t-1" }] };
    }
    if (sql.includes("FROM object_comment")) {
      return {
        rows: [
          {
            comment_id: "c-1",
            thread_id: "t-1",
            author_user_id: "other-user",
            body: "first",
            references: [],
            attachment_rids: [
              { rid: "ri.a.lnk", filename: "a.pdf" },
              { rid: "ri.a.unl", filename: "b.pdf" },
            ],
            created_at: "2026-09-17T10:00:00Z",
            edited_at: null,
          },
          {
            comment_id: "c-2",
            thread_id: "t-1",
            author_user_id: "reader-1",
            body: "second",
            references: [],
            attachment_rids: [{ rid: "ri.a.up", filename: "c.pdf" }],
            created_at: "2026-09-17T10:05:00Z",
            edited_at: null,
          },
        ],
      };
    }
    return { rows: [] };
  });
}

describe("listComments — inaccessible attachment rids are omitted", () => {
  it("keeps uploader + readable-linked rids, drops the rest", async () => {
    wireWorkshopDb();
    const { listComments } = await import("../../../src/services/workshop/commentService");
    const comments = await listComments("VerifyTaxpayer", "pk-1", SECURITY as any);

    expect(comments).toHaveLength(2);
    // other-user's comment: linked-and-readable stays, unlinked is dropped.
    expect(comments[0].attachments.map((a) => a.rid)).toEqual(["ri.a.lnk"]);
    // reader's own upload stays via the uploader rule.
    expect(comments[1].attachments.map((a) => a.rid)).toEqual(["ri.a.up"]);
  });
});
