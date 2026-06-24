// =============================================================================
// B10 — Action validate + apply unit tests
//
// Spec §B10:
//   - validate(p) returns same shape as apply(p).validation
//   - StaleObjectError → Tellus:Workshop:ActionStaleObject 409
//   - apply emits modifiedProperties in the edits envelope
//
// Contract IDs:
//   B10 C-01: validate(p) and apply(p).validation are deeply equal for all p
//   B10 C-02: StaleObjectError → ActionStaleObject 409
//   B10 C-03: validate forwards branch + JWT verbatim
//   B10 C-04: apply forwards branch + JWT verbatim
//   B10 C-05: apply returns the adapter's edits unchanged
// =============================================================================

import { beforeEach, describe, expect, it } from "vitest";
import {
  validate,
  apply,
} from "../../../src/services/workshop/actionApplyService.js";
import {
  RecordingActionsAdapter,
  setActions,
  StaleObjectError,
  type ActionApplyRequest,
  type ActionValidationResult,
  type ActionApplyResponse,
} from "../../../src/services/workshop/actionsAdapter.js";
import type { OssRequestContext } from "../../../src/services/workshop/ossAdapter.js";
import { WorkshopError } from "../../../src/services/workshop/errors.js";

const CTX: OssRequestContext = {
  jwt: "jwt-test",
  branchRid: "ri.branch.b1",
  userRid: "u-1",
};

let actions: RecordingActionsAdapter;

beforeEach(() => {
  actions = new RecordingActionsAdapter();
  setActions(actions);
});

describe("B10 C-01: validate(p) === apply(p).validation (property-based)", () => {
  it("for any (action, parameters), the validate result equals the apply.validation result", async () => {
    // Adapter returns a deterministic validation phase output. The service
    // is a thin wrapper, so the property holds by construction; the test
    // documents the contract and would fail if the wrapper diverges.
    const cases: ActionApplyRequest[] = [
      {
        ontologyRid: "o1",
        actionTypeApiName: "assignOrder",
        parameters: { assignee: "alice", status: "assigned" },
      },
      {
        ontologyRid: "o1",
        actionTypeApiName: "createOrder",
        parameters: {},
      },
      {
        ontologyRid: "o2",
        actionTypeApiName: "deleteCustomer",
        parameters: { id: "c-1" },
      },
    ];
    // Stable: per-request validation outcome based on params.
    const programmable = new RecordingActionsAdapter(
      (r) => ({
        valid: Object.keys(r.parameters).length > 0,
        errors:
          Object.keys(r.parameters).length === 0
            ? [
                {
                  path: "$",
                  code: "PARAMS_REQUIRED",
                  message: "no parameters supplied",
                },
              ]
            : [],
      }),
      (r) => ({
        validation: {
          valid: Object.keys(r.parameters).length > 0,
          errors:
            Object.keys(r.parameters).length === 0
              ? [
                  {
                    path: "$",
                    code: "PARAMS_REQUIRED",
                    message: "no parameters supplied",
                  },
                ]
              : [],
        },
        edits: {
          modifiedObjects: [],
          modifiedProperties: Object.keys(r.parameters),
          createdObjects: [],
          deletedObjects: [],
        },
      }),
    );
    setActions(programmable);
    for (const c of cases) {
      const v = await validate(c, CTX);
      const a = await apply(c, CTX);
      expect(v).toEqual(a.validation);
    }
  });
});

describe("B10 C-02: StaleObjectError → ActionStaleObject 409", () => {
  it("maps adapter exception to workshop envelope", async () => {
    setActions(
      new RecordingActionsAdapter(undefined, () => {
        throw new StaleObjectError("Order", "o-99", "v3", "v4");
      }),
    );
    try {
      await apply(
        {
          ontologyRid: "o1",
          actionTypeApiName: "assignOrder",
          parameters: { assignee: "x" },
        },
        CTX,
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkshopError);
      const w = err as WorkshopError;
      expect(w.errorName).toBe("Tellus:Workshop:ActionStaleObject");
      expect(w.httpStatus).toBe(409);
      expect(w.parameters["objectTypeApiName"]).toBe("Order");
      expect(w.parameters["primaryKey"]).toBe("o-99");
      expect(w.parameters["expectedVersion"]).toBe("v3");
      expect(w.parameters["actualVersion"]).toBe("v4");
    }
  });

  it("does NOT auto-retry — adapter is invoked exactly once", async () => {
    let invocations = 0;
    setActions(
      new RecordingActionsAdapter(undefined, () => {
        invocations += 1;
        throw new StaleObjectError("Order", "o-1", "v1", "v2");
      }),
    );
    try {
      await apply(
        {
          ontologyRid: "o1",
          actionTypeApiName: "assignOrder",
          parameters: { assignee: "y" },
        },
        CTX,
      );
    } catch {
      // expected
    }
    expect(invocations).toBe(1);
  });
});

describe("B10 C-03/C-04: branch + JWT forwarded verbatim", () => {
  it("validate passes ctx through unchanged", async () => {
    await validate(
      {
        ontologyRid: "o1",
        actionTypeApiName: "assignOrder",
        parameters: {},
      },
      CTX,
    );
    expect(actions.calls).toHaveLength(1);
    expect(actions.calls[0]!.context).toEqual(CTX);
    expect(actions.calls[0]!.kind).toBe("validate");
  });
  it("apply passes ctx through unchanged", async () => {
    await apply(
      {
        ontologyRid: "o1",
        actionTypeApiName: "assignOrder",
        parameters: {},
      },
      CTX,
    );
    expect(actions.calls[0]!.context).toEqual(CTX);
    expect(actions.calls[0]!.kind).toBe("apply");
  });
});

describe("B10 C-05: apply returns the adapter's edits unchanged", () => {
  it("modifiedProperties propagated", async () => {
    setActions(
      new RecordingActionsAdapter(undefined, () => ({
        validation: { valid: true, errors: [] },
        edits: {
          modifiedObjects: [{ objectTypeApiName: "Order", primaryKey: "80060" }],
          modifiedProperties: ["assignee", "status"],
          createdObjects: [],
          deletedObjects: [],
        },
      })),
    );
    const out: ActionApplyResponse = await apply(
      {
        ontologyRid: "o1",
        actionTypeApiName: "assignOrder",
        parameters: { assignee: "alice" },
      },
      CTX,
    );
    expect(out.edits.modifiedProperties).toEqual(["assignee", "status"]);
    expect(out.edits.modifiedObjects).toEqual([
      { objectTypeApiName: "Order", primaryKey: "80060" },
    ]);
    expect(out.validation.valid).toBe(true);
  });
});
