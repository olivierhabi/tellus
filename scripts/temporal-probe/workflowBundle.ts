// Probe workflow: one activity call `recordReceipt` — the receipt
// (which build executed) is written by the activity in the plain Node
// process of whichever worker claims the task.
export async function versioningProbeWorkflow(input: { wfId: string }): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { proxyActivities } = require("@temporalio/workflow") as typeof import("@temporalio/workflow");
  const { recordReceipt } = proxyActivities<{ recordReceipt: (wfId: string) => Promise<void> }>({
    startToCloseTimeout: "30s",
    retry: { maximumAttempts: 1 },
  });
  await recordReceipt(input.wfId);
  return `done:${input.wfId}`;
}
