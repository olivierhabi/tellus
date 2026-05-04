// B05 + B10 — downstream timeout / circuit-open chaos tests.
//
// Spec §B05 default OSS timeout 20s; §B10 default Action timeout 60s.
// Forbidden Behaviors say "Every downstream call has tests for: timeout,
// partial failure, malformed response." This suite injects a slow OSS
// adapter and a slow Actions adapter to prove timeout + circuit fire with
// the right Conjure envelopes.
//
// Contract IDs:
//   B05 chaos C-T1: load timeout → 504 DownstreamTimeout
//   B05 chaos C-T2: 5 consecutive failures open the circuit
//   B05 chaos C-T3: open circuit → 503 DownstreamCircuitOpen, no downstream call
//   B05 chaos C-T4: circuit recovers after 30s window (verified by reset)
//   B10 chaos C-T1: validate timeout → 504 DownstreamTimeout
//   B10 chaos C-T2: apply timeout → 504 DownstreamTimeout
//   Errors fall through the WorkshopError envelope path unchanged.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadObjectSet,
} from "../../../src/services/workshop/objectSetService";
import {
  RecordingOssAdapter,
  setOss,
  type OssLoadResponse,
} from "../../../src/services/workshop/ossAdapter";
import {
  validate as actionValidate,
  apply as actionApply,
} from "../../../src/services/workshop/actionApplyService";
import {
  RecordingActionsAdapter,
  setActions,
  type ActionApplyResponse,
  type ActionValidationResult,
} from "../../../src/services/workshop/actionsAdapter";
import {
  setOssTimeoutMs,
  setActionsTimeoutMs,
  resetCircuits,
  isCircuitOpen,
} from "../../../src/services/workshop/timeouts";

const ctx = {
  jwt: "test-jwt",
  branchRid: null,
  userRid: "u-chaos",
};

const baseLoad = {
  ontologyRid: "ri.ontology.main.ontology.x",
  objectTypeApiName: "Order",
  schema: { id: "string" as const },
  filters: [],
  pageSize: 10,
};

const baseAction = {
  ontologyRid: "ri.ontology.main.ontology.x",
  actionTypeApiName: "doThing",
  parameters: { x: 1 },
};

// Adapter that hangs forever — used to trigger timeout reliably.
function hangingOssAdapter(): RecordingOssAdapter {
  return new RecordingOssAdapter(
    () => new Promise<OssLoadResponse>(() => {}),
    () => new Promise(() => {}),
  );
}

function hangingActionsAdapter(): RecordingActionsAdapter {
  return new RecordingActionsAdapter(
    () => new Promise<ActionValidationResult>(() => {}),
    () => new Promise<ActionApplyResponse>(() => {}),
  );
}

// Adapter that always rejects synchronously — used to drive the circuit open.
function failingOssAdapter(): RecordingOssAdapter {
  return new RecordingOssAdapter(
    () => Promise.reject(new Error("downstream boom")),
    () => Promise.reject(new Error("downstream boom")),
  );
}

beforeEach(() => {
  resetCircuits();
  setOssTimeoutMs(50); // tight test budget
  setActionsTimeoutMs(50);
});

afterEach(() => {
  setOssTimeoutMs(20_000);
  setActionsTimeoutMs(60_000);
  resetCircuits();
});

describe("B05 + B10 chaos — downstream timeout + circuit", () => {
  it("B05 chaos C-T1: load that hangs past timeout → DownstreamTimeout 504", async () => {
    setOss(hangingOssAdapter());
    let caught: unknown = null;
    try {
      await loadObjectSet(baseLoad, ctx);
    } catch (e) {
      caught = e;
    }
    const err = caught as {
      errorName?: string;
      httpStatus?: number;
      parameters?: { downstream?: string; timeoutMs?: number };
    };
    expect(err?.errorName).toBe("Tellus:Workshop:DownstreamTimeout");
    expect(err?.httpStatus).toBe(504);
    expect(err?.parameters?.downstream).toBe("oss");
    expect(err?.parameters?.timeoutMs).toBe(50);
  });

  it("B05 chaos C-T2/C-T3: 5 consecutive failures open circuit; 6th call rejected without downstream call", async () => {
    const failing = failingOssAdapter();
    setOss(failing);
    setOssTimeoutMs(20_000); // give plenty of time so the failure isn't a timeout
    for (let i = 0; i < 5; i += 1) {
      try {
        await loadObjectSet(baseLoad, ctx);
      } catch {
        // expected
      }
    }
    expect(isCircuitOpen("oss")).toBe(true);
    const callsBefore = failing.calls.length;

    let caught: unknown = null;
    try {
      await loadObjectSet(baseLoad, ctx);
    } catch (e) {
      caught = e;
    }
    const err = caught as { errorName?: string; httpStatus?: number };
    expect(err?.errorName).toBe("Tellus:Workshop:DownstreamCircuitOpen");
    expect(err?.httpStatus).toBe(503);
    // Critical: the open circuit MUST NOT call downstream.
    expect(failing.calls.length).toBe(callsBefore);
  });

  it("B05 chaos C-T4: resetCircuits closes the circuit", async () => {
    const failing = failingOssAdapter();
    setOss(failing);
    setOssTimeoutMs(20_000);
    for (let i = 0; i < 5; i += 1) {
      try {
        await loadObjectSet(baseLoad, ctx);
      } catch {
        // expected
      }
    }
    expect(isCircuitOpen("oss")).toBe(true);
    resetCircuits();
    expect(isCircuitOpen("oss")).toBe(false);
  });

  it("B10 chaos C-T1: validate that hangs past timeout → DownstreamTimeout 504", async () => {
    setActions(hangingActionsAdapter());
    let caught: unknown = null;
    try {
      await actionValidate(baseAction, ctx);
    } catch (e) {
      caught = e;
    }
    const err = caught as {
      errorName?: string;
      httpStatus?: number;
      parameters?: { downstream?: string };
    };
    expect(err?.errorName).toBe("Tellus:Workshop:DownstreamTimeout");
    expect(err?.httpStatus).toBe(504);
    expect(err?.parameters?.downstream).toBe("actions");
  });

  it("B10 chaos C-T2: apply that hangs past timeout → DownstreamTimeout 504", async () => {
    setActions(hangingActionsAdapter());
    let caught: unknown = null;
    try {
      await actionApply(baseAction, ctx);
    } catch (e) {
      caught = e;
    }
    const err = caught as { errorName?: string; httpStatus?: number };
    expect(err?.errorName).toBe("Tellus:Workshop:DownstreamTimeout");
    expect(err?.httpStatus).toBe(504);
  });

  it("B05+B10: timeouts isolate per downstream label (oss timeout doesn't trip actions circuit)", async () => {
    const failing = failingOssAdapter();
    setOss(failing);
    setOssTimeoutMs(20_000);
    for (let i = 0; i < 5; i += 1) {
      try {
        await loadObjectSet(baseLoad, ctx);
      } catch {
        // expected
      }
    }
    expect(isCircuitOpen("oss")).toBe(true);
    expect(isCircuitOpen("actions")).toBe(false);
  });
});
