// ---------------------------------------------------------------------------
// tests/integration/code-repos/stemma-events/subscription-store-integration.test.ts
//
// Spec contracts:
//   B10-C-11  webhook subscriber registry (per-repo OR global; ACTIVE/SUSPENDED)
//   B10-C-14  5 consecutive failures → state = SUSPENDED (atomic)
//   B10-C-15  fan-out lookup index hit when listing matching ACTIVE subs
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
  createSubscription,
  getSubscription,
  listMatchingActiveSubscriptions,
  reactivateSubscription,
  recordDeliveryFailure,
  recordDeliverySuccess,
  SUBSCRIPTION_FAILURE_THRESHOLD,
  SubscriptionStoreError,
} from "../../../../src/services/stemmaEvents/store/subscriptionStore";

const REPO_RID =
  "ri.stemma.main.repository.cccccccc-cccc-cccc-cccc-cccccccccccc";
const REPO_RID_OTHER =
  "ri.stemma.main.repository.dddddddd-dddd-dddd-dddd-dddddddddddd";

function newSubRid(suffix: string): string {
  return `ri.stemma.main.subscription.${suffix.padEnd(8, "x")}-${"x".repeat(4)}-4${"x".repeat(3)}-x${"x".repeat(3)}-${"x".repeat(12)}`;
}

describe("B10 — subscription store", () => {
  let ctx: SchemaContext;

  beforeAll(async () => {
    ctx = await openTestSchema("subscription_store");
    await ctx.applyMigration("src/migrations/052_b10_stemma_events.sql");
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  describe("createSubscription validation", () => {
    it("rejects empty event_types with EmptyEventTypes BEFORE round-trip", async () => {
      await expect(
        createSubscription(ctx.pool, {
          rid: newSubRid("emptyev"),
          eventTypes: [],
          repositoryRid: REPO_RID,
          targetUri: "https://example.test/hook",
          secretEncrypted: "secret-enc",
        }),
      ).rejects.toMatchObject({
        name: "SubscriptionStoreError",
        code: "EmptyEventTypes",
      });
    });

    it("rejects unknown event type with UnknownEventType", async () => {
      await expect(
        createSubscription(ctx.pool, {
          rid: newSubRid("badeventtype"),
          eventTypes: ["BOGUS" as never],
          repositoryRid: REPO_RID,
          targetUri: "https://example.test/hook",
          secretEncrypted: "secret-enc",
        }),
      ).rejects.toMatchObject({
        code: "UnknownEventType",
      });
    });

    it("rejects target_uri longer than 2048 chars with TargetUriTooLong", async () => {
      await expect(
        createSubscription(ctx.pool, {
          rid: newSubRid("toolong"),
          eventTypes: ["PUSH"],
          repositoryRid: REPO_RID,
          targetUri: "https://" + "x".repeat(2050),
          secretEncrypted: "secret-enc",
        }),
      ).rejects.toMatchObject({ code: "TargetUriTooLong" });
    });

    it("rejects empty target_uri with TargetUriEmpty", async () => {
      await expect(
        createSubscription(ctx.pool, {
          rid: newSubRid("emptyuri"),
          eventTypes: ["PUSH"],
          repositoryRid: REPO_RID,
          targetUri: "",
          secretEncrypted: "secret-enc",
        }),
      ).rejects.toMatchObject({ code: "TargetUriEmpty" });
    });

    it("rejects duplicate rid with AlreadyExists", async () => {
      const rid = newSubRid("dupe");
      await createSubscription(ctx.pool, {
        rid,
        eventTypes: ["PUSH"],
        repositoryRid: REPO_RID,
        targetUri: "https://example.test/hook",
        secretEncrypted: "secret-enc",
      });
      await expect(
        createSubscription(ctx.pool, {
          rid,
          eventTypes: ["PUSH"],
          repositoryRid: REPO_RID,
          targetUri: "https://example.test/hook",
          secretEncrypted: "secret-enc",
        }),
      ).rejects.toMatchObject({ code: "AlreadyExists" });
    });
  });

  describe("listMatchingActiveSubscriptions", () => {
    let perRepo!: string;
    let global!: string;
    let otherRepo!: string;

    beforeAll(async () => {
      perRepo = newSubRid("perrepo");
      global = newSubRid("global");
      otherRepo = newSubRid("otherrepo");
      await createSubscription(ctx.pool, {
        rid: perRepo,
        eventTypes: ["PUSH", "TAG"],
        repositoryRid: REPO_RID,
        targetUri: "https://per-repo.test/hook",
        secretEncrypted: "s1",
      });
      await createSubscription(ctx.pool, {
        rid: global,
        eventTypes: ["PUSH"],
        repositoryRid: null, // global
        targetUri: "https://global.test/hook",
        secretEncrypted: "s2",
      });
      await createSubscription(ctx.pool, {
        rid: otherRepo,
        eventTypes: ["PUSH"],
        repositoryRid: REPO_RID_OTHER,
        targetUri: "https://other.test/hook",
        secretEncrypted: "s3",
      });
    });

    it("includes per-repo subscription matching the repo + event_type", async () => {
      const subs = await listMatchingActiveSubscriptions(
        ctx.pool,
        REPO_RID,
        "PUSH",
      );
      const rids = subs.map((s) => s.rid);
      expect(rids).toContain(perRepo);
    });

    it("includes global subscription regardless of repo", async () => {
      const subs = await listMatchingActiveSubscriptions(
        ctx.pool,
        REPO_RID,
        "PUSH",
      );
      expect(subs.map((s) => s.rid)).toContain(global);
    });

    it("excludes per-other-repo subscriptions", async () => {
      const subs = await listMatchingActiveSubscriptions(
        ctx.pool,
        REPO_RID,
        "PUSH",
      );
      expect(subs.map((s) => s.rid)).not.toContain(otherRepo);
    });

    it("excludes subscriptions whose event_types does not include the event", async () => {
      const subs = await listMatchingActiveSubscriptions(
        ctx.pool,
        REPO_RID,
        "PR_OPENED",
      );
      expect(subs.map((s) => s.rid)).not.toContain(perRepo);
      expect(subs.map((s) => s.rid)).not.toContain(global);
    });
  });

  describe("recordDeliveryFailure — atomic 5-failure auto-suspend (B10-C-14)", () => {
    let rid!: string;

    beforeAll(async () => {
      rid = newSubRid("failctr");
      await createSubscription(ctx.pool, {
        rid,
        eventTypes: ["PUSH"],
        repositoryRid: REPO_RID,
        targetUri: "https://flaky.test/hook",
        secretEncrypted: "enc",
      });
    });

    it("first 4 failures keep state = ACTIVE", async () => {
      for (let i = 1; i <= 4; i++) {
        const post = await recordDeliveryFailure(ctx.pool, rid);
        expect(post.consecutiveFailures).toBe(i);
        expect(post.state).toBe("ACTIVE");
      }
    });

    it("5th failure flips state to SUSPENDED in the same UPDATE", async () => {
      const post = await recordDeliveryFailure(ctx.pool, rid);
      expect(post.consecutiveFailures).toBe(SUBSCRIPTION_FAILURE_THRESHOLD);
      expect(post.state).toBe("SUSPENDED");

      const row = await getSubscription(ctx.pool, rid);
      expect(row?.state).toBe("SUSPENDED");
    });

    it("SUSPENDED subscription is excluded from listMatchingActiveSubscriptions", async () => {
      const subs = await listMatchingActiveSubscriptions(
        ctx.pool,
        REPO_RID,
        "PUSH",
      );
      expect(subs.map((s) => s.rid)).not.toContain(rid);
    });

    it("recordDeliverySuccess on a (now-reactivated) sub resets the counter to 0", async () => {
      const reactivated = await reactivateSubscription(ctx.pool, rid);
      expect(reactivated?.state).toBe("ACTIVE");
      expect(reactivated?.consecutiveFailures).toBe(0);

      // Even after a partial-failure sequence, success resets the counter.
      await recordDeliveryFailure(ctx.pool, rid);
      await recordDeliveryFailure(ctx.pool, rid);
      await recordDeliverySuccess(ctx.pool, rid);
      const row = await getSubscription(ctx.pool, rid);
      expect(row?.consecutiveFailures).toBe(0);
      expect(row?.state).toBe("ACTIVE");
    });

    it("recordDeliveryFailure on a missing subscription throws NotFound", async () => {
      await expect(
        recordDeliveryFailure(ctx.pool, newSubRid("absent")),
      ).rejects.toMatchObject({
        name: "SubscriptionStoreError",
        code: "NotFound",
      });
    });
  });

  describe("concurrent failure-records do not race past the threshold", () => {
    it("two parallel failure-records on a subscription with 4 prior failures never push past SUSPENDED", async () => {
      const rid = newSubRid("racersub");
      await createSubscription(ctx.pool, {
        rid,
        eventTypes: ["PUSH"],
        repositoryRid: REPO_RID,
        targetUri: "https://racer.test/hook",
        secretEncrypted: "enc",
      });
      // Bring up to 4 failures.
      for (let i = 0; i < 4; i++) await recordDeliveryFailure(ctx.pool, rid);

      // Two concurrent failure-records.
      const [a, b] = await Promise.all([
        recordDeliveryFailure(ctx.pool, rid),
        recordDeliveryFailure(ctx.pool, rid),
      ]);
      // Whichever lands first hits the threshold (5) and flips to SUSPENDED.
      // The other simply increments to 6 — still SUSPENDED. Both are
      // valid outcomes; the invariant is "state ends up SUSPENDED" and
      // "consecutiveFailures >= threshold".
      const final = await getSubscription(ctx.pool, rid);
      expect(final?.state).toBe("SUSPENDED");
      expect(final?.consecutiveFailures).toBeGreaterThanOrEqual(
        SUBSCRIPTION_FAILURE_THRESHOLD,
      );
      // Both calls should return the post-update consecutiveFailures.
      expect([a.consecutiveFailures, b.consecutiveFailures]).toEqual(
        expect.arrayContaining([5, 6]),
      );
    });
  });
});
