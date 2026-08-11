export const QA_ROUTING_REJECTION = "QA_INJECT_ROUTING_REJECTION";
export const QA_DEPENDENCY_FAILURE = "QA_INJECT_DEPENDENCY_FAILURE";

export function rwandaQaFailure(
  actionTypeApiName: string,
  parameters: Record<string, unknown>,
): { code: "WRITEBACK_REJECTED"; message: string } | null {
  if (process.env.TELLUS_TEST_HOOKS !== "1") return null;
  if (
    actionTypeApiName === "qaRwPindoSwitchCarrierRoute" &&
    parameters.reason === QA_ROUTING_REJECTION
  ) {
    return {
      code: "WRITEBACK_REJECTED",
      message: "Injected routing API rejection before ontology writeback",
    };
  }
  const failureField = ["reason", "rationale", "note"]
    .find((field) => parameters[field] === QA_DEPENDENCY_FAILURE);
  if (failureField && /^qaRw(?:Bk|Irembo|Rswitch|Pindo)/.test(actionTypeApiName)) {
    return {
      code: "WRITEBACK_REJECTED",
      message: `Injected dependency failure before mutation (${failureField})`,
    };
  }
  return null;
}
