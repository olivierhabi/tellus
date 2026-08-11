import { afterEach, describe, expect, it } from "vitest";
import { QA_DEPENDENCY_FAILURE, QA_ROUTING_REJECTION, rwandaQaFailure } from "../../../src/qa/rwanda/failureInjection";

describe("Rwanda failure injection gate", () => {
  const prior = process.env.TELLUS_TEST_HOOKS;
  afterEach(() => { process.env.TELLUS_TEST_HOOKS = prior; });

  it("is unavailable unless test hooks are explicit", () => {
    delete process.env.TELLUS_TEST_HOOKS;
    expect(rwandaQaFailure("qaRwPindoSwitchCarrierRoute", { reason: QA_ROUTING_REJECTION })).toBeNull();
  });

  it("injects only the namespaced routing rejection", () => {
    process.env.TELLUS_TEST_HOOKS = "1";
    expect(rwandaQaFailure("qaRwPindoSwitchCarrierRoute", { reason: QA_ROUTING_REJECTION })?.code)
      .toBe("WRITEBACK_REJECTED");
    expect(rwandaQaFailure("SwitchCarrierRoute", { reason: QA_ROUTING_REJECTION })).toBeNull();
  });

  it("supports each namespaced scenario dependency hook", () => {
    process.env.TELLUS_TEST_HOOKS = "1";
    for (const [action, field] of [
      ["qaRwBkApproveCreditLimit", "rationale"],
      ["qaRwIremboApproveTransfer", "note"],
      ["qaRwRswitchReconcileTransaction", "reason"],
      ["qaRwPindoSwitchCarrierRoute", "reason"],
    ] as const) {
      expect(rwandaQaFailure(action, { [field]: QA_DEPENDENCY_FAILURE })?.code)
        .toBe("WRITEBACK_REJECTED");
    }
  });
});
