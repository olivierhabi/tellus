// ---------------------------------------------------------------------------
// LINK_INDEX_ACK_REQUIRED startup precondition (Fix 2 — config half).
//
// The flag vouches that a committed link mutation is queryable through the
// INDEXED serving store. Enabling it against a legacy / shadow serving mode
// would have the ack barrier assert visibility of a store the READ path may
// not use — worse than no flag (it lies). Boot fails fast for that; the
// runtime half (CH reachability / schema / consumer plausibility) is gated
// at /health/ready (see src/routes/healthReady.ts).
//
// Extracted from server.ts so the precondition matrix is unit-testable
// without booting the process.
// ---------------------------------------------------------------------------

/**
 * Throw an unambiguous, flag-naming error when the ack flag is on but
 * the configured serving mode cannot honour a visibility verdict.
 * No-op when the flag is off (the contract isn't vouching anything).
 */
export function assertLinkIndexAckStartupConfig(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.LINK_INDEX_ACK_REQUIRED !== "true") return;
  const envMode = (env.SERVING_STORE_MODE ?? "legacy").toLowerCase();
  // service/serving/servingFlags.ts: 'shadow' runs the index BESIDE legacy
  // reads; a verdict the read path may not consult is unsafe to vouch.
  if (envMode !== "indexed") {
    // eslint-disable-next-line no-console
    console.error(
      `[boot] FATAL: LINK_INDEX_ACK_REQUIRED=true but SERVING_STORE_MODE='${envMode}' is not 'indexed' — the ack barrier would vouch for a serving store no read path uses. Set SERVING_STORE_MODE=indexed or unset LINK_INDEX_ACK_REQUIRED.`,
    );
    throw new Error(
      `LINK_INDEX_ACK_REQUIRED requires SERVING_STORE_MODE=indexed (got '${envMode}')`,
    );
  }
}
