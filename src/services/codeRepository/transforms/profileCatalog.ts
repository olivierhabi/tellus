// ===========================================================================
// profileCatalog.ts — the Foundry-aligned @configure resource-profile catalog.
//
// Gap 6 enforcement: Foundry treats @configure(profile=[...]) as a VALIDATED
// resource hint — unknown profile names are REJECTED at scheduling time. This
// implements that gate as pure logic (no cluster needed). buildService calls
// validateProfile() during discovery; an unknown name fails the build with
// Transform:InvalidTransform carrying the unknown names.
//
// SCOPE NOTE: mapping a validated profile to ACTUAL driver/executor memory
// requires a Spark-submit/cluster path (--driver-memory / --executor-memory /
// --num-executors). In local-mode (master("local[2]")) there is no cluster to
// size — spark.driver.memory set in-process is cosmetic. So this gate
// VALIDATES (rejects unknown) but does not ALLOCATE resources. Real resource
// allocation is a cluster-deployment concern (out of scope for this pass).
// ===========================================================================

// The known profile names. Aligned with Foundry's resource-profile vocabulary
// (driver memory, executor memory, CPU, single-node RAM). A deployment may
// extend this set; the gate rejects anything not in it.
export const PROFILE_CATALOG: ReadonlySet<string> = new Set<string>([
  // Spark driver memory.
  "DRIVER_MEMORY_SMALL",
  "DRIVER_MEMORY_MEDIUM",
  "DRIVER_MEMORY_LARGE",
  // Spark executor memory.
  "EXECUTOR_MEMORY_SMALL",
  "EXECUTOR_MEMORY_MEDIUM",
  "EXECUTOR_MEMORY_LARGE",
  // CPU profiles.
  "CPU_SMALL",
  "CPU_MEDIUM",
  "CPU_LARGE",
  // Single-node RAM (for @transform_pandas).
  "SINGLE_NODE_RAM_SMALL",
  "SINGLE_NODE_RAM_MEDIUM",
  "SINGLE_NODE_RAM_LARGE",
]);

/**
 * Validate a @configure profile list against the catalog. @configure is
 * OPTIONAL (null/empty -> ok). Unknown names -> {ok:false, unknown:[...]}.
 */
export function validateProfile(
  profile: string[] | null | undefined,
): { ok: true } | { ok: false; unknown: string[] } {
  if (!profile || profile.length === 0) return { ok: true };
  const unknown = profile.filter((p) => !PROFILE_CATALOG.has(p));
  return unknown.length > 0 ? { ok: false, unknown } : { ok: true };
}
