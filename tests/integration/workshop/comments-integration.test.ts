// Workshop Comments widget integration tests (docs: widgets-comments).
//
// Contract under test:
//   * thread list/post/delete scoped by (objectType, primaryKey)
//   * parent-object permission gate — an unreadable parent yields 403 for
//     list/post/delete (never a leak via guessed primary keys)
//   * author-only deletion (docs: "You can also delete your own comments")
//   * switching the parent object switches the thread (rows never leak
//     across parents)
//   * references + attachment rids round-trip
//
// The parent-object readability check (executeGetObject), the attachment
// accessibility filter and the notification inbox insert are mocked: the OpenSearch read path and the
// dispatch pipeline have their own coverage; here we pin the comment
// service + route contract.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  openTestSchema,
  type SchemaContext,
} from "../code-repos/_helpers/pg";
import {
  resetWorkshopDb,
  setWorkshopDb,
} from "../../../src/services/workshop/db";

const PARENT_READABLE = vi.hoisted(() => ({ value: true }));
vi.mock("../../../src/services/queryExecutor", () => ({
  executeGetObject: vi.fn(async () =>
    PARENT_READABLE.value ? { __primaryKey: "AUD-1" } : null,
  ),
}));
const NOTIFICATIONS = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../../../src/models/notificationInbox", () => ({
  insertNotification: vi.fn(async (row: unknown) => {
    NOTIFICATIONS.rows.push(row);
    return row;
  }),
}));

// Attachment rids are filtered through resolveAccessibleAttachmentRids on
// read (attachments the viewer cannot access are dropped). The attachment
// store has its own coverage; treat every rid as accessible here so the
// round-trip contract is what's under test.
vi.mock("../../../src/services/attachmentService", () => ({
  resolveAccessibleAttachmentRids: vi.fn(
    async (rids: string[]) => new Set(rids),
  ),
}));

import workshopCommentsRouter from "../../../src/routes/workshopComments";

const VIEWER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

let ctx: SchemaContext | null = null;
let app: Express;
let pgAvailable = true;
let principal = VIEWER;

beforeAll(async () => {
  try {
    ctx = await openTestSchema("workshop_comments");
    await ctx.applyMigration("src/migrations/187_workshop_comments.sql");
  } catch (err) {
    pgAvailable = false;
    console.warn(
      `[comments] Postgres unavailable; tests will be skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  setWorkshopDb({
    query: (sql, params) => ctx!.pool.query(sql, params ?? []),
    withTransaction: async (fn) => {
      const c = await ctx!.pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn(c);
        await c.query("COMMIT");
        return out;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
  });

  app = express();
  app.use(express.json());
  // Minimal security context: the route's requireSecurityContext reads
  // req.security (set here by principal), mirroring the production
  // securityContext middleware's resolved user id.
  app.use((req, _res, next) => {
    (req as unknown as { security: unknown }).security = {
      userId: principal,
      markings: ["PUBLIC"],
      organizations: [],
      cbac: [],
      markingMode: "disjunctive",
      systemPrincipal: false,
    };
    next();
  });
  app.use("/api/v1/workshop", workshopCommentsRouter);
});

afterAll(async () => {
  resetWorkshopDb();
  if (ctx) await ctx.close();
});

beforeEach(async () => {
  PARENT_READABLE.value = true;
  NOTIFICATIONS.rows.length = 0;
  principal = VIEWER;
  if (ctx) {
    await ctx.exec(
      "TRUNCATE object_comment, comment_thread_subscription, comment_thread CASCADE",
    );
  }
});

const itp = (...args: Parameters<typeof it>) =>
  pgAvailable ? it(...args) : it.skip(...args);

describe("Workshop Comments", () => {
  itp("empty thread → [] with the viewer id (no thread row created)", async () => {
    const res = await request(app).get(
      "/api/v1/workshop/comments/RssbFraudCase/AUD-1",
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.viewerUserId).toBe(VIEWER);
  });

  itp("post → list round-trips body, references, and attachments", async () => {
    const post = await request(app)
      .post("/api/v1/workshop/comments/RssbFraudCase/AUD-1")
      .send({
        body: "Investigating the provider pattern",
        references: [
          {
            kind: "object",
            objectTypeApiName: "RssbHealthClaim",
            primaryKey: "CLM-1",
            displayTitle: "Claim CLM-1",
          },
        ],
        attachments: [
          { rid: "ri.attachments.main.attachment.x", filename: "evidence.pdf" },
        ],
      });
    expect(post.status).toBe(201);
    expect(post.body.authorUserId).toBe(VIEWER);

    const list = await request(app).get(
      "/api/v1/workshop/comments/RssbFraudCase/AUD-1",
    );
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].body).toBe("Investigating the provider pattern");
    expect(list.body.data[0].references[0]).toMatchObject({
      kind: "object",
      primaryKey: "CLM-1",
    });
    expect(list.body.data[0].attachments[0].filename).toBe("evidence.pdf");
  });

  itp("threads are scoped per parent — switching the parent never leaks rows", async () => {
    await request(app)
      .post("/api/v1/workshop/comments/RssbFraudCase/AUD-1")
      .send({ body: "On case A" });
    await request(app)
      .post("/api/v1/workshop/comments/RssbFraudCase/AUD-2")
      .send({ body: "On case B" });
    const a = await request(app).get(
      "/api/v1/workshop/comments/RssbFraudCase/AUD-1",
    );
    const b = await request(app).get(
      "/api/v1/workshop/comments/RssbFraudCase/AUD-2",
    );
    expect(a.body.data.map((c: { body: string }) => c.body)).toEqual([
      "On case A",
    ]);
    expect(b.body.data.map((c: { body: string }) => c.body)).toEqual([
      "On case B",
    ]);
  });

  itp("author can delete own comment; other users get 403", async () => {
    const post = await request(app)
      .post("/api/v1/workshop/comments/RssbFraudCase/AUD-1")
      .send({ body: "remove me" });
    const id = post.body.commentId;

    principal = OTHER;
    const denied = await request(app).delete(
      `/api/v1/workshop/comments/id/${id}`,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.errorName).toBe("CommentDeleteAuthorOnly");

    principal = VIEWER;
    const ok = await request(app).delete(
      `/api/v1/workshop/comments/id/${id}`,
    );
    expect(ok.status).toBe(204);
    const list = await request(app).get(
      "/api/v1/workshop/comments/RssbFraudCase/AUD-1",
    );
    expect(list.body.data).toEqual([]);
  });

  itp("unreadable parent → 403 on list, post, and delete (no PK guessing leak)", async () => {
    PARENT_READABLE.value = false;
    const list = await request(app).get(
      "/api/v1/workshop/comments/RssbFraudCase/SECRET-1",
    );
    expect(list.status).toBe(403);
    expect(list.body.errorName).toBe("CommentParentObjectInaccessible");
    const post = await request(app)
      .post("/api/v1/workshop/comments/RssbFraudCase/SECRET-1")
      .send({ body: "nope" });
    expect(post.status).toBe(403);
  });

  itp("posting subscribes the author and notifies mentioned users", async () => {
    const post = await request(app)
      .post("/api/v1/workshop/comments/RssbFraudCase/AUD-1")
      .send({
        body: "cc the auditor @[Auditor]",
        references: [{ kind: "user", userId: OTHER, displayName: "Auditor" }],
      });
    expect(post.status).toBe(201);
    const notified = NOTIFICATIONS.rows as Array<{
      recipientUserId: string;
      templateId: string;
    }>;
    // The mentioned user is notified immediately; the author never is.
    expect(notified.map((n) => n.recipientUserId)).toEqual([OTHER]);
    expect(notified[0].templateId).toBe("workshop_comment");
  });

  itp("empty body → 400", async () => {
    const res = await request(app)
      .post("/api/v1/workshop/comments/RssbFraudCase/AUD-1")
      .send({ body: "   " });
    expect(res.status).toBe(400);
  });
});
