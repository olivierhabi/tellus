// ---------------------------------------------------------------------------
// B10 — pre-receive policy decision (pure logic).
//
// Spec contracts:
//   B10-C-01  Synchronous; Stemma awaits within 5s. Pure logic here is
//             O(1) per ref-update; the 5s budget is hit only by the
//             outer Compass call (timeout-bounded in the HTTP wrapper).
//   B10-C-04  Checks run IN ORDER, FAIL-FAST per ref:
//               1. regex (B10-C-05)
//               2. protected-branch policy (B10-C-06..08)
//               3. tag immutability (B10-C-09)
//               4. Compass.canAct(EDITOR) (B10-C-10)
//             A ref that fails step N is reported with the step-N error;
//             later checks are skipped for that ref.
//   B10-C-21  When repoSettings.json is in the same push, the OLD
//             settings (the snapshot supplied to this function) are
//             used. The caller is responsible for fetching pre-push
//             settings; this module never reads from disk.
//
// Design notes:
//   - Each ref is decided independently. The policy returns one Decision
//     per ref so Stemma can report per-ref reject reasons in
//     `Stemma:RefUpdateRejected.parameters` (B1-C-28).
//   - Compass is called LAST so the in-process checks (cheap, no I/O)
//     fail-fast and the expensive RPC is skipped when avoidable.
//   - The policy does NOT mutate any input. All inputs are readonly.
//   - "OWNER override" for tag immutability (B10-C-09) is the only role
//     check at the policy level; Compass owns the rest of authz.
// ---------------------------------------------------------------------------

import type {
  Decision,
  PushContext,
  RefUpdate,
  RepoSettingsSnapshot,
} from "./types";

/**
 * Decide each ref-update in `updates` per the B10-C-04 fail-fast order.
 * Returns one Decision per input update, in the same order.
 *
 * The function is async only because the optional Compass callback may
 * return a Promise. It performs no I/O of its own and is safe to call
 * inside any test harness.
 */
export async function preReceiveDecision(
  updates: readonly RefUpdate[],
  ctx: PushContext,
): Promise<readonly Decision[]> {
  const decisions: Decision[] = [];
  for (const u of updates) {
    decisions.push(await decideOne(u, ctx));
  }
  return decisions;
}

async function decideOne(
  u: RefUpdate,
  ctx: PushContext,
): Promise<Decision> {
  const isTag = u.ref.startsWith("refs/tags/");
  const isBranch = u.ref.startsWith("refs/heads/");

  // -------------------------------------------------------------------------
  // Step 1 — regex (B10-C-05).
  // -------------------------------------------------------------------------
  if (isBranch) {
    const stripped = u.ref.slice("refs/heads/".length);
    if (!matchesRegex(stripped, ctx.settings.branchNameValidation)) {
      return deny(u.ref, "BranchProtection:RegexViolation", 400, {
        ref: u.ref,
        regex: ctx.settings.branchNameValidation,
      });
    }
  } else if (isTag) {
    const stripped = u.ref.slice("refs/tags/".length);
    if (!matchesRegex(stripped, ctx.settings.tagNameValidation)) {
      return deny(u.ref, "BranchProtection:RegexViolation", 400, {
        ref: u.ref,
        regex: ctx.settings.tagNameValidation,
      });
    }
  }
  // Unrecognised ref namespaces (refs/notes/*, refs/stash, custom) bypass
  // step 1 — Stemma's pre-validation already filters them at the smart-
  // HTTP layer. We do not invent rejections the spec does not require.

  // -------------------------------------------------------------------------
  // Step 2 — protected-branch policy (B10-C-06..08).
  // -------------------------------------------------------------------------
  if (isBranch && isProtected(u.ref, ctx.settings)) {
    if (u.isDelete) {
      return deny(u.ref, "BranchProtection:DeleteProtected", 403, {
        ref: u.ref,
      });
    }
    if (u.isForce) {
      return deny(u.ref, "BranchProtection:ForcePushProtected", 403, {
        ref: u.ref,
      });
    }
    if (ctx.settings.requirePullRequest && !ctx.viaPullRequest) {
      return deny(u.ref, "BranchProtection:RequiresPullRequest", 403, {
        ref: u.ref,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 3 — tag immutability (B10-C-09).
  //
  // Tags are append-only: deletes and updates are denied UNLESS the
  // principal carries the OWNER role. (Pure creates of new tags are
  // always allowed past this step.)
  // -------------------------------------------------------------------------
  if (isTag && (u.isDelete || !u.isCreate)) {
    if (!ctx.principal.roles.includes("OWNER")) {
      return deny(u.ref, "BranchProtection:TagImmutable", 403, {
        ref: u.ref,
        reason: u.isDelete ? "delete" : "update",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 4 — Compass.canAct(EDITOR) (B10-C-10).
  // -------------------------------------------------------------------------
  if (ctx.canActAsEditor) {
    const allowed = await Promise.resolve(ctx.canActAsEditor());
    if (!allowed) {
      return deny(u.ref, "Compass:PermissionDenied", 403, {
        ref: u.ref,
        repositoryRid: ctx.repositoryRid,
        operation: "EDITOR",
      });
    }
  }

  return { kind: "allow", ref: u.ref };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DenyErrorName = Extract<Decision, { kind: "deny" }>["errorName"];

function deny(
  ref: string,
  errorName: DenyErrorName,
  httpStatus: 400 | 403,
  parameters: Record<string, unknown>,
): Decision {
  return {
    kind: "deny",
    ref,
    errorName,
    httpStatus,
    parameters: Object.freeze(parameters),
  };
}

/**
 * Compile and apply a string-form regex to a candidate. Always anchored
 * (B10-C-05 says "match"; we treat the whole stripped name). A malformed
 * regex from repoSettings is treated as a deny — settings can only
 * land via B2's validation, so a malformed regex here means corruption
 * or skipping that gate; either way fail-closed.
 */
function matchesRegex(candidate: string, regexSource: string): boolean {
  try {
    // Anchor unconditionally. If the source already includes ^…$ the
    // anchored wrapper is a no-op (anchors at the leading/trailing edge
    // are idempotent).
    const re = new RegExp(`^(?:${regexSource})$`);
    return re.test(candidate);
  } catch {
    return false; // fail-closed
  }
}

/**
 * Glob-style match for protected-branch entries. Supports `*` (matches
 * any sequence not containing `/`) and `**` (matches any sequence
 * including `/`). A bare entry without wildcards matches a literal
 * branch name. The leading `refs/heads/` is stripped from the candidate
 * before matching (settings refer to bare branch names).
 */
function isProtected(ref: string, settings: RepoSettingsSnapshot): boolean {
  const branchName = ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : ref;
  for (const entry of settings.protectedBranches) {
    if (matchesGlob(branchName, entry)) return true;
  }
  return false;
}

function matchesGlob(s: string, glob: string): boolean {
  // Convert the glob to a RegExp:
  //   `**` → `.*`, `*` → `[^/]*`, every other regex metachar is escaped.
  // We do this in two passes because `*` is a substring of `**` and a
  // naive replace would corrupt the substitution.
  let i = 0;
  let pattern = "";
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      pattern += ".*";
      i += 2;
    } else if (c === "*") {
      pattern += "[^/]*";
      i += 1;
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      pattern += `\\${c}`;
      i += 1;
    } else {
      pattern += c;
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`).test(s);
}
