// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §5 — Object Storage V2: object-level real-time subscriptions.
//
// Covers the pure routing decision (shouldDeliver), the subscription
// message handler (handleObjectSubscription), and the actionExecutor's
// object_set.changed emission contract (event shape on the bus).
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  shouldDeliver,
  handleObjectSubscription,
  type RoutableWsEvent,
} from "../../../src/websocket/server";

const ONTOLOGY = "11111111-2222-3333-4444-555555555555";

function state(topics: string[] = [], projects: string[] = []) {
  return {
    subscribedObjectTopics: new Set(topics),
    subscribedProjects: new Set(projects),
  };
}

describe("shouldDeliver — object-topic routing", () => {
  const event: RoutableWsEvent = {
    event: "object_set.changed",
    projectId: null,
    objectTopic: `${ONTOLOGY}:Employee`,
    payload: {},
  };

  it("delivers to an exact object-type subscriber", () => {
    expect(shouldDeliver(event, state([`${ONTOLOGY}:Employee`]))).toBe(true);
  });

  it("delivers to an ontology-wildcard subscriber", () => {
    expect(shouldDeliver(event, state([`${ONTOLOGY}:*`]))).toBe(true);
  });

  it("does NOT deliver object events to unsubscribed clients (no broadcast)", () => {
    expect(shouldDeliver(event, state())).toBe(false);
    expect(shouldDeliver(event, state([`${ONTOLOGY}:Aircraft`]))).toBe(false);
  });

  it("does NOT leak object events to project subscribers", () => {
    expect(shouldDeliver(event, state([], ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]))).toBe(false);
  });

  it("keeps legacy behavior for non-object events", () => {
    const projectEvent: RoutableWsEvent = {
      event: "dataset.parsed",
      projectId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      payload: {},
    };
    expect(
      shouldDeliver(projectEvent, state([], ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"])),
    ).toBe(true);
    expect(shouldDeliver(projectEvent, state())).toBe(false);
    const broadcast: RoutableWsEvent = {
      event: "funnel_state.changed",
      projectId: null,
      payload: {},
    };
    expect(shouldDeliver(broadcast, state())).toBe(true);
  });
});

describe("handleObjectSubscription", () => {
  it("subscribes to a specific object type", () => {
    const s = state();
    const reply = handleObjectSubscription(s, {
      action: "subscribeObjects",
      ontologyId: ONTOLOGY,
      objectType: "Employee",
    });
    expect(reply).toEqual({
      type: "subscribedObjects",
      topic: `${ONTOLOGY}:Employee`,
    });
    expect(s.subscribedObjectTopics.has(`${ONTOLOGY}:Employee`)).toBe(true);
  });

  it("subscribes ontology-wide when objectType is omitted", () => {
    const s = state();
    const reply = handleObjectSubscription(s, {
      action: "subscribeObjects",
      ontologyId: ONTOLOGY,
    });
    expect(reply?.topic).toBe(`${ONTOLOGY}:*`);
  });

  it("unsubscribes", () => {
    const s = state([`${ONTOLOGY}:Employee`]);
    const reply = handleObjectSubscription(s, {
      action: "unsubscribeObjects",
      ontologyId: ONTOLOGY,
      objectType: "Employee",
    });
    expect(reply?.type).toBe("unsubscribedObjects");
    expect(s.subscribedObjectTopics.size).toBe(0);
  });

  it("rejects malformed ontologyId and objectType", () => {
    const s = state();
    expect(
      handleObjectSubscription(s, { action: "subscribeObjects", ontologyId: "nope" })?.type,
    ).toBe("error");
    expect(
      handleObjectSubscription(s, {
        action: "subscribeObjects",
        ontologyId: ONTOLOGY,
        objectType: "bad name!",
      })?.type,
    ).toBe("error");
    expect(s.subscribedObjectTopics.size).toBe(0);
  });

  it("returns null for non-object actions (falls through to legacy handling)", () => {
    expect(
      handleObjectSubscription(state(), { action: "subscribe", ontologyId: ONTOLOGY }),
    ).toBeNull();
  });
});

describe("actionExecutor object_set.changed emission contract", () => {
  it("the executor source emits ws:event with an objectTopic per affected type", async () => {
    // Source-contract pin (same style as funnel-state FE/BE pins): the
    // emission must exist, be grouped by object type, and never be able
    // to fail the action (wrapped in try/catch).
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(
      resolve(__dirname, "../../../src/actions/actionExecutor.ts"),
      "utf8",
    );
    expect(/eventBus\.emit\(\s*['"]ws:event['"]/.test(src)).toBe(true);
    expect(/event:\s*['"]object_set\.changed['"]/.test(src)).toBe(true);
    expect(/objectTopic:\s*`\$\{ontologyId\}:\$\{objectType\}`/.test(src)).toBe(true);
    expect(/catch \(emitErr\)/.test(src)).toBe(true);
    expect(/primaryKeys/.test(src)).toBe(true);
  });
});
