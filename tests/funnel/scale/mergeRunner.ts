// Child-process merge runner for O3 (o3-kill-resume.scale.test.ts). Runs ONE
// runMergeActivity in its own Node process so the parent can SIGKILL the
// whole worker (not just a DuckDB child) mid staging-load / promote — the
// same failure a Temporal worker pod OOM-kill produces. The retry is a fresh
// process with the identical activity input, as Temporal would deliver it.
//
//   node --import tsx tests/funnel/scale/mergeRunner.ts '<json MergeInput>' ['<json overrides>']
import "../../laneEnv";

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? "{}");
  const overrides = process.argv[3] ? JSON.parse(process.argv[3]) : null;
  if (overrides) {
    const { setFunnelRuntimeOverridesForTesting } = await import("../../../src/config/funnelRuntime");
    setFunnelRuntimeOverridesForTesting(overrides);
  }
  const acts = await import("../../../src/services/funnel/temporal/activities");
  const r = await acts.runMergeActivity(input);
  process.stdout.write(`MERGE_RESULT ${JSON.stringify({ objectsIndexed: r.objectsIndexed, upserts: r.upserts, mergedSnapshotId: r.mergedSnapshotId })}\n`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
