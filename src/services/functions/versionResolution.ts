// ---------------------------------------------------------------------------
// versionResolution.ts — semantic-version range resolution for Automate
// Function-effect automatic upgrades.
//
// Replaces the old "exact jsonb signature equality" resolution with:
//   • range:      >=pinned <(major+1).0.0   (never crosses the major)
//   • floor:      pinned versions below 1.0.0 NEVER auto-upgrade
//   • stability:  prerelease candidates are excluded unless explicitly
//                 selected (the pinned version itself is never displaced by
//                 a prerelease)
//   • signature:  isSignatureUpgradeCompatible (appended optional params OK;
//                 renames/removals/reorders/type-changes breaking)
//   • contract:   the invocation contract must be identical
//
// Resolution returns the HIGHEST compatible stable candidate. The result is
// resolved ONCE per automation effect execution and pinned (see
// effectExecutors.executeFunctionEffect + automation_effect_execution
// resolved_* columns) — retries re-execute the SAME immutable artifact.
// ---------------------------------------------------------------------------

import { compareSemver, parseSemver } from "../functionsRegistry/semver";
import {
  isSignatureUpgradeCompatible,
  readCanonicalSignature,
  type InvocationContract,
} from "./canonicalSignature";

export interface UpgradeCandidate {
  semver: string;
  signature: unknown;
  invocationContract: InvocationContract;
}

/**
 * Pick the highest semver compatible with the pinned version within
 * `>=pinned <(major+1).0.0`, or null when no candidate qualifies.
 *
 * @param pinnedSemver    the version configured on the effect
 * @param candidates      stable-ness is enforced here; pass every version
 *                        row for the same function + branch + kind.
 */
export function resolveCompatibleUpgrade(input: {
  pinnedSemver: string;
  pinnedSignature: unknown;
  pinnedContract: InvocationContract;
  candidates: ReadonlyArray<UpgradeCandidate>;
}): UpgradeCandidate | null {
  const pinned = parseSemver(input.pinnedSemver);
  // Versions below 1.0.0 make no compatibility promise — never auto-upgrade.
  if (pinned.major < 1) return null;
  const pinnedSignature = readCanonicalSignature(input.pinnedSignature);
  if (!pinnedSignature) return null;

  const eligible = input.candidates
    .filter((candidate) => {
      let parsed;
      try {
        parsed = parseSemver(candidate.semver);
      } catch {
        return false;
      }
      // Exclude prereleases unless one is the explicitly pinned version
      // itself (pinned is returned by the caller, never by this resolver).
      if (parsed.preRelease.length > 0) return false;
      // Never cross the current major; never downgrade.
      if (parsed.major !== pinned.major) return false;
      return compareSemver(parsed, pinned) > 0;
    })
    .sort((a, b) => compareSemver(parseSemver(b.semver), parseSemver(a.semver)));

  for (const candidate of eligible) {
    if (candidate.invocationContract !== input.pinnedContract) continue;
    const candidateSignature = readCanonicalSignature(candidate.signature);
    if (!candidateSignature) continue;
    if (isSignatureUpgradeCompatible(pinnedSignature, candidateSignature)) {
      return candidate;
    }
  }
  return null;
}
