// ---------------------------------------------------------------------------
// tests/integration/code-repos/stemma-events/callback-dispatcher-integration.test.ts
//
// Spec contracts:
//   B10-C-13  HMAC-SHA256 signature on every callback in X-Tellus-Signature
//   B10-C-14  5 consecutive failures → state = SUSPENDED
//   B10-C-15  Async fan-out — failed deliveries do not crash the dispatcher
//
// Integration-grade because the failure counter + auto-suspend is in
// real Postgres. The HTTP delivery is injected so we don't need a
// running webhook server.
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
  SUBSCRIPTION_FAILURE_THRESHOLD,
} from "../../../../src/services/stemmaEvents/store/subscriptionStore";
import {
  insertEventWithinTx,
  type StemmaEvent,
} from "../../../../src/services/stemmaEvents/store/eventStore";
import {
  dispatchEvent,
  type CallbackDelivery,
  type DispatcherDeps,
} from "../../../../src/services/stemmaEvents/dispatcher/callbackDispatcher";
import {
  SIGNATURE_HEADER,
  SIGNATURE_PREFIX,
  verifyCallbackSignature,
} from "../../../../src/services/stemmaEvents/hmac";

const REPO_RID =
  "ri.stemma.main.repository.eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

function newRid(prefix: string, suffix: string): string {
  return `ri.stemma.main.${prefix}.${suffix.padEnd(8, "f")}-${"f".repeat(4)}-4${"f".repeat(3)}-f${"f".repeat(3)}-${"f".repeat(12)}`;
}

interface CapturedCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** In-memory deliverer that returns canned outcomes per call index. */
function makeDeliverer(plan: ReadonlyArray<number | "throw">): {
  deliver: CallbackDelivery;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let i = 0;
  const deliver: CallbackDelivery = async (req) => {
    calls.push({ url: req.url, body: req.body, headers: req.headers });
    const outcome = plan[i++ % plan.length];
    if (outcome === "throw") throw new Error("transport-failure");
    return { status: outcome };
  };
  return { deliver, calls };
}

async function insertEvent(
  ctx: SchemaContext,
  ridSuffix: string,
): Promise<StemmaEvent> {
  return ctx.withTx((client) =>
    insertEventWithinTx(client, {
      rid: newRid("event", ridSuffix),
      repositoryRid: REPO_RID,
      eventType: "PUSH",
      ref: "refs/heads/main",
      oldSha: "0000000000000000000000000000000000000000",
      newSha: "abcdef0123456789abcdef0123456789abcdef01",
      principalSub: null,
      payload: { ridSuffix },
    }),
  );
}

describe("B10 — callback dispatcher (HMAC + auto-suspend)", () => {
  let ctx: SchemaContext;
  const SECRET = "shhhh-its-a-secret";

  beforeAll(async () => {
    ctx = await openTestSchema("dispatcher");
    await ctx.applyMigration("src/migrations/052_b10_stemma_events.sql");
  });

  afterAll(async () => {
    if (ctx) await ctx.close();
  });

  it("delivers to every matching ACTIVE subscription with HMAC signature (B10-C-13)", async () => {
    const subRid = newRid("subscription", "happy01");
    await createSubscription(ctx.pool, {
      rid: subRid,
      eventTypes: ["PUSH"],
      repositoryRid: REPO_RID,
      targetUri: "https://happy.test/hook",
      secretEncrypted: SECRET, // identity decryptor below
    });
    const event = await insertEvent(ctx, "happy001");

    const { deliver, calls } = makeDeliverer([200]);
    const deps: DispatcherDeps = {
      pool: ctx.pool,
      deliver,
      decryptSecret: (e) => e,
    };

    const results = await dispatchEvent(deps, event);
    const r = results.find((x) => x.subscriptionRid === subRid);
    expect(r?.outcome).toBe("delivered");
    expect(r?.httpStatus).toBe(200);
    expect(r?.consecutiveFailures).toBe(0);
    expect(r?.state).toBe("ACTIVE");

    expect(calls.length).toBe(1);
    const call = calls[0];
    expect(call.url).toBe("https://happy.test/hook");
    expect(call.headers[SIGNATURE_HEADER]).toMatch(
      new RegExp(`^${SIGNATURE_PREFIX}[0-9a-f]{64}$`),
    );
    // Verifying the signature with the right secret confirms B10-C-13.
    expect(
      verifyCallbackSignature(call.headers[SIGNATURE_HEADER], call.body, SECRET),
    ).toBe(true);
    // Body carries the event id + canonical fields.
    const parsed = JSON.parse(call.body);
    expect(parsed.event_id).toBe(event.rid);
    expect(parsed.event_type).toBe("PUSH");
    expect(parsed.repository_rid).toBe(REPO_RID);
  });

  it("5 consecutive non-2xx callbacks auto-suspend the subscription (B10-C-14)", async () => {
    const subRid = newRid("subscription", "flaky01");
    await createSubscription(ctx.pool, {
      rid: subRid,
      eventTypes: ["PUSH"],
      repositoryRid: REPO_RID,
      targetUri: "https://flaky.test/hook",
      secretEncrypted: SECRET,
    });

    const { deliver } = makeDeliverer([500, 503, 502, 504, 500]);
    const deps: DispatcherDeps = {
      pool: ctx.pool,
      deliver,
      decryptSecret: (e) => e,
    };

    // Five separate events → five separate dispatch passes.
    for (let i = 0; i < 5; i++) {
      const event = await insertEvent(ctx, `flaky${String(i).padStart(3, "0")}`);
      const results = await dispatchEvent(deps, event);
      const r = results.find((x) => x.subscriptionRid === subRid);
      // The fifth call sees state SUSPENDED because the dispatcher's
      // listMatchingActiveSubscriptions excludes SUSPENDED rows after
      // they are flipped — so on attempt 5, this subscription will
      // still be picked up by listMatching (it was ACTIVE when the
      // list query ran), get a 500, increment to 5, flip to SUSPENDED.
      // After that it's invisible to future fan-outs.
      if (i < 4) {
        expect(r?.consecutiveFailures).toBe(i + 1);
        expect(r?.state).toBe("ACTIVE");
      } else {
        expect(r?.consecutiveFailures).toBe(SUBSCRIPTION_FAILURE_THRESHOLD);
        expect(r?.state).toBe("SUSPENDED");
      }
    }

    // After the fifth failure, the subscription is excluded from new dispatches.
    const event6 = await insertEvent(ctx, "afterssp");
    const results6 = await dispatchEvent(deps, event6);
    expect(results6.find((x) => x.subscriptionRid === subRid)).toBeUndefined();

    const final = await getSubscription(ctx.pool, subRid);
    expect(final?.state).toBe("SUSPENDED");
  });

  it("transport-layer throw is treated as a failure (no rethrow up the dispatcher)", async () => {
    const subRid = newRid("subscription", "throwy");
    await createSubscription(ctx.pool, {
      rid: subRid,
      eventTypes: ["PUSH"],
      repositoryRid: REPO_RID,
      targetUri: "https://throwy.test/hook",
      secretEncrypted: SECRET,
    });
    const event = await insertEvent(ctx, "throwy01");

    const { deliver } = makeDeliverer(["throw"]);
    const deps: DispatcherDeps = {
      pool: ctx.pool,
      deliver,
      decryptSecret: (e) => e,
    };

    // Should NOT throw — failures are surfaced as DispatchResult entries.
    const results = await dispatchEvent(deps, event);
    const r = results.find((x) => x.subscriptionRid === subRid);
    expect(r?.outcome).toBe("failed");
    expect(r?.httpStatus).toBeNull();
    expect(r?.consecutiveFailures).toBe(1);
    expect(r?.state).toBe("ACTIVE");
  });

  it("a 2xx after failures resets the counter to 0", async () => {
    const subRid = newRid("subscription", "recover");
    await createSubscription(ctx.pool, {
      rid: subRid,
      eventTypes: ["PUSH"],
      repositoryRid: REPO_RID,
      targetUri: "https://recover.test/hook",
      secretEncrypted: SECRET,
    });

    // Fail 3 times.
    {
      const { deliver } = makeDeliverer([500, 500, 500]);
      const deps: DispatcherDeps = {
        pool: ctx.pool,
        deliver,
        decryptSecret: (e) => e,
      };
      for (let i = 0; i < 3; i++) {
        const ev = await insertEvent(ctx, `rec${String(i).padStart(3, "0")}`);
        await dispatchEvent(deps, ev);
      }
    }
    expect((await getSubscription(ctx.pool, subRid))?.consecutiveFailures).toBe(3);

    // One success — counter must reset.
    {
      const { deliver } = makeDeliverer([204]);
      const deps: DispatcherDeps = {
        pool: ctx.pool,
        deliver,
        decryptSecret: (e) => e,
      };
      const ev = await insertEvent(ctx, "recover-yay");
      const results = await dispatchEvent(deps, ev);
      const r = results.find((x) => x.subscriptionRid === subRid);
      expect(r?.outcome).toBe("delivered");
      expect(r?.consecutiveFailures).toBe(0);
    }
  });

  it("subscriptions that don't match the event_type are skipped", async () => {
    const subRid = newRid("subscription", "nomatch");
    await createSubscription(ctx.pool, {
      rid: subRid,
      eventTypes: ["TAG"], // does NOT include PUSH
      repositoryRid: REPO_RID,
      targetUri: "https://nomatch.test/hook",
      secretEncrypted: SECRET,
    });
    const event = await insertEvent(ctx, "nomatch1");

    const { deliver, calls } = makeDeliverer([200]);
    const deps: DispatcherDeps = {
      pool: ctx.pool,
      deliver,
      decryptSecret: (e) => e,
    };
    const results = await dispatchEvent(deps, event);
    expect(results.find((x) => x.subscriptionRid === subRid)).toBeUndefined();
    expect(calls.find((c) => c.url === "https://nomatch.test/hook")).toBeUndefined();
  });
});
