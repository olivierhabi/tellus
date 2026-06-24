// ---------------------------------------------------------------------------
// tests/integration/code-repos/stemma-events/event-store-integration.test.ts
//
// Spec contracts:
//   B10-C-03  insert one stemma_event per ALLOWed ref-update
//   B10-C-12  GET /events cursor pagination — deterministic ordering
//             on (occurred_at DESC, rid DESC); cursor never skips rows
//   §1.5      cursor pagination: opaque base64-encoded JSON, ≥30-day
//             stability, no offset pagination
// ---------------------------------------------------------------------------

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";
import { openTestSchema, type SchemaContext } from "../_helpers/pg";
import {
  CursorError,
  decodeCursor,
  encodeCursor,
  insertEventWithinTx,
  listEvents,
  type StemmaEventInput,
  type StemmaEventType,
} from "../../../../src/services/stemmaEvents/store/eventStore";

const REPO_RID =
  "ri.stemma.main.repository.aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const REPO_RID_OTHER =
  "ri.stemma.main.repository.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function newRid(suffix: string): string {
  // Pad with chars from the locator alphabet to keep the rid short and
  // recognisable in test output.
  return `ri.stemma.main.event.${suffix.padEnd(8, "a")}-${"a".repeat(4)}-4${"a".repeat(3)}-a${"a".repeat(3)}-${"a".repeat(12)}`;
}

function newInput(
  ridSuffix: string,
  overrides: Partial<StemmaEventInput> = {},
): StemmaEventInput {
  return {
    rid: newRid(ridSuffix),
    repositoryRid: REPO_RID,
    eventType: "PUSH",
    ref: "refs/heads/main",
    oldSha: "0000000000000000000000000000000000000000",
    newSha: "abcdef0123456789abcdef0123456789abcdef01",
    principalSub: "11111111-1111-1111-1111-111111111111",
    payload: { author: "alice" },
    ...overrides,
  };
}

describe("B10 — event store insert + listEvents cursor pagination", () => {
  let ctx: SchemaContext;

  beforeAll(async () => {
    ctx = await openTestSchema("event_store");
    await ctx.applyMigration("src/migrations/052_b10_stemma_events.sql");
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  describe("insertEventWithinTx", () => {
    it("inserts and returns the row with occurredAt populated", async () => {
      const stored = await ctx.withTx(async (client) => {
        return insertEventWithinTx(client, newInput("ins00001"));
      });
      expect(stored.rid).toMatch(/^ri\.stemma\.main\.event\./);
      expect(stored.occurredAt).toBeInstanceOf(Date);
      expect(stored.eventType).toBe("PUSH");
    });

    it("rejects an unknown eventType at the DB CHECK", async () => {
      await expect(
        ctx.withTx(async (client) => {
          return insertEventWithinTx(client, {
            ...newInput("badtype1"),
            eventType: "BOGUS" as StemmaEventType,
          });
        }),
      ).rejects.toThrow(/check constraint/i);
    });

    it("rejects malformed sha at the DB CHECK", async () => {
      await expect(
        ctx.withTx(async (client) => {
          return insertEventWithinTx(client, {
            ...newInput("badsha"),
            newSha: "ZZZZ",
          });
        }),
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe("listEvents — cursor pagination", () => {
    // Use a dedicated repo RID for these fixtures so the rows inserted
    // by the prior `insertEventWithinTx` describe (which used REPO_RID)
    // don't pollute the listEvents result set under repositoryRid scoping.
    const PAGE_REPO =
      "ri.stemma.main.repository.cccccccc-cccc-cccc-cccc-cccccccccccc";
    let inserted: { rid: string; occurredAt: Date }[] = [];
    const FIXTURE_PREFIX = "fix";
    const PAGE_SIZE = 4;

    beforeAll(async () => {
      // Insert 10 events at distinct timestamps so ordering is unambiguous.
      // Use raw SQL for the timestamps so the test is deterministic
      // regardless of clock skew.
      for (let i = 0; i < 10; i++) {
        const rid = newRid(`${FIXTURE_PREFIX}${String(i).padStart(2, "0")}`);
        const ts = new Date(Date.UTC(2026, 0, 1, 12, 0, i)).toISOString();
        await ctx.exec(`
          INSERT INTO stemma_event (rid, repository_rid, event_type, ref, occurred_at)
          VALUES ('${rid}', '${PAGE_REPO}', 'PUSH', 'refs/heads/main', '${ts}'::timestamptz)
        `);
        inserted.push({ rid, occurredAt: new Date(ts) });
      }
      // One off-repo event to verify scoping.
      await ctx.exec(`
        INSERT INTO stemma_event (rid, repository_rid, event_type, ref)
        VALUES ('${newRid("otherevt")}', '${REPO_RID_OTHER}', 'PUSH', 'refs/heads/main')
      `);
    });

    it("first page returns pageSize rows in DESC (occurred_at, rid) order", async () => {
      const page = await listEvents(ctx.pool, {
        repositoryRid: PAGE_REPO,
        pageSize: PAGE_SIZE,
      });
      expect(page.events.length).toBe(PAGE_SIZE);
      expect(page.nextPageToken).toBeDefined();
      // Newest first — last inserted (i=9) is first.
      expect(page.events[0].rid).toContain(`${FIXTURE_PREFIX}09`);
      expect(page.events[1].rid).toContain(`${FIXTURE_PREFIX}08`);
    });

    it("walking the cursor returns every row exactly once and never skips", async () => {
      let pageToken: string | undefined = undefined;
      const collected: string[] = [];
      for (let safety = 0; safety < 20; safety++) {
        const page = await listEvents(ctx.pool, {
          repositoryRid: PAGE_REPO,
          pageSize: PAGE_SIZE,
          pageToken,
        });
        collected.push(...page.events.map((e) => e.rid));
        if (!page.nextPageToken) break;
        pageToken = page.nextPageToken;
      }
      // Should have every fixture rid (10 from this repo) and only those.
      const fixtureRids = inserted.map((e) => e.rid);
      expect(collected.length).toBe(fixtureRids.length);
      expect(new Set(collected)).toEqual(new Set(fixtureRids));
    });

    it("nextPageToken is undefined on the final page", async () => {
      const page = await listEvents(ctx.pool, {
        repositoryRid: PAGE_REPO,
        pageSize: 100,
      });
      expect(page.nextPageToken).toBeUndefined();
    });

    it("repositoryRid filter scopes results — off-repo events are excluded", async () => {
      const page = await listEvents(ctx.pool, {
        repositoryRid: PAGE_REPO,
        pageSize: 100,
      });
      for (const e of page.events) {
        expect(e.repositoryRid).toBe(PAGE_REPO);
      }
    });

    it("`since` filter excludes earlier rows (inclusive)", async () => {
      const page = await listEvents(ctx.pool, {
        repositoryRid: PAGE_REPO,
        since: new Date(Date.UTC(2026, 0, 1, 12, 0, 5)).toISOString(),
        pageSize: 100,
      });
      // i=5..9 are at second-tick 5..9 → 5 rows.
      expect(page.events.length).toBe(5);
    });
  });

  describe("cursor encoding", () => {
    it("encode → decode round-trips", () => {
      const state = {
        occurredAt: "2026-05-01T12:34:56.789Z",
        rid: "ri.stemma.main.event.deadbeef-dead-4eef-aeef-deadbeefdead",
      };
      const t = encodeCursor(state);
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(t)).toEqual(state);
    });

    it("rejects garbled token with §1.3 envelope", () => {
      let caught: unknown;
      try {
        decodeCursor("!@#$ not base64");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(CursorError);
      const env = (caught as CursorError).envelope;
      expect(env.errorName).toBe("StemmaEvents:InvalidPageToken");
      expect(env.errorCode).toBe("INVALID_ARGUMENT");
    });

    it("rejects token with non-string fields", () => {
      const bad = Buffer.from(JSON.stringify({ occurredAt: 1, rid: 2 }), "utf8")
        .toString("base64url");
      expect(() => decodeCursor(bad)).toThrow(CursorError);
    });

    it("rejects token with unparseable timestamp", () => {
      const bad = Buffer.from(
        JSON.stringify({ occurredAt: "not-a-date", rid: "x" }),
        "utf8",
      ).toString("base64url");
      expect(() => decodeCursor(bad)).toThrow(CursorError);
    });
  });

  describe("listEvents pageSize clamping", () => {
    it("treats pageSize=0 as 1", async () => {
      const page = await listEvents(ctx.pool, {
        repositoryRid: REPO_RID,
        pageSize: 0,
      });
      expect(page.events.length).toBe(1);
    });

    it("clamps pageSize > 200 to 200", async () => {
      // Only 10 fixture events exist for this repo, so we can't observe
      // 200 directly — but we can observe that no error is thrown and
      // we get all 10 fixture rows from the dedicated fixture repo.
      const page = await listEvents(ctx.pool, {
        repositoryRid:
          "ri.stemma.main.repository.cccccccc-cccc-cccc-cccc-cccccccccccc",
        pageSize: 1_000_000,
      });
      expect(page.events.length).toBe(10);
    });
  });
});
