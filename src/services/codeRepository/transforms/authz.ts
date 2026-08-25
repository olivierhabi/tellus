// ===========================================================================
// authz.ts — the build/materialize-path dataset access seam (P0).
//
// Closes the authz bypass: a user with repo-WRITE (the only gate on the build
// routes) could read ANY foundry-catalog dataset via Input("<its rid>") and
// overwrite ANY via Output("<its rid>>"). This seam enforces per-dataset
// read/write on BOTH the input-resolution path (resolveTransformInput) and the
// output-materialization path (materializeOutput), using the existing
// per-dataset primitive DatasetAclService.effectiveRole().
//
// Design (see plans/fluffy-kindling-minsky.md):
//   - Identity = the triggering user (threaded from req.codeReposPrincipal on
//     interactive paths; persisted at enqueue for the boot-recovery path).
//   - Fail-closed: a check ERROR is not permission granted -> deny.
//   - Superadmin bypass: tellus-superadmin (platform-wide) -> allow.
//   - TOCTOU: check as close to the op as practical (input before staging,
//     output before the S3 upload).
//   - Kill switch TRANSFORM_DATASET_AUTHZ_ENABLED (default ON). OFF -> fail-open
//     (restore service during an incident). ON + check error -> fail-closed.
//   - Per-dataset, NOT transitive: each immediate input is checked independently.
//   - userId-only (no groupIds on the principal) -> group-ACL grants are a
//     documented limitation; direct user grants + the project_members floor apply.
// ===========================================================================
import type { DatasetRole } from "../../datasetAcl.js";
import { incCounter } from "../../funnel/metrics.js";
import { logger } from "../../../logging/pino.js";

const TELLUS_SUPERADMIN_ROLE = "tellus-superadmin";

/** The identity a build runs as + is authorized against: the triggering user
 * (userId + roles). Threaded from req.codeReposPrincipal on interactive paths;
 * persisted at enqueue for the boot-recovery path (rerunQueuedBuild). */
export interface TransformPrincipal {
  readonly userId: string;
  readonly roles: readonly string[];
}

/** Build a TransformPrincipal from a roles-bearing principal (the code-repos
 * principal). Defensively coerces roles to a string[]. */
export function transformPrincipalFrom(userId: string, roles: readonly string[] | undefined): TransformPrincipal {
  return { userId, roles: roles ? [...roles] : [] };
}

/** Kill switch — default ON (enforces). OFF -> enforcement skipped (fail-open).
 * Independent of DATASET_RBAC_ENABLED (which gates the route-level dataset
 * RBAC middleware, a separate concern). Read at call time (not module load) so
 * an operator can toggle it via env without a restart + so tests can stub it. */
function isAuthzEnabled(): boolean {
  return (process.env.TRANSFORM_DATASET_AUTHZ_ENABLED ?? "true").toLowerCase() === "true";
}

const SUPERADMIN_BYPASS_ROLES = new Set([TELLUS_SUPERADMIN_ROLE]);

/** read = any non-null role (viewer/editor/owner — viewer is the floor).
 * write = editor or owner (editor implies read; owner outranks editor). */
function roleSatisfies(role: DatasetRole | null, op: "read" | "write"): boolean {
  if (role === null) return false;
  if (op === "read") return true;
  return role === "editor" || role === "owner";
}

export interface AssertAccessArgs {
  readonly principal: TransformPrincipal;
  /** The foundry_datasets.id (the rid's UUID suffix). */
  readonly datasetUuid: string;
  readonly op: "read" | "write";
  /** The dataset RID — used for audit/metrics labels (more useful than the uuid). */
  readonly datasetRid?: string;
}

/**
 * Assert the principal has {op} access to the foundry-catalog dataset.
 *
 * - Throws Transform:PermissionDenied (403) on DENIAL or on a CHECK ERROR
 *   (fail-closed — an exception during a permission check is not permission
 *   granted).
 * - Returns void on ALLOW (no audit — allow is the common path; denial/error
 *   are the security-relevant events that get an audit row + metric).
 * - No-op (fail-open) when the kill switch is OFF.
 *
 * Audits denials + errors to tellus_audit_events (structured, queryable) +
 * increments transform_authz_denials_total{dataset,principal,op} /
 * transform_authz_check_errors_total{op} (exposed via /metrics).
 */
export async function assertDatasetAccess(args: AssertAccessArgs): Promise<void> {
  const { principal, datasetUuid, op, datasetRid } = args;

  // Kill switch — fail-open (restore service during an incident).
  if (!isAuthzEnabled()) return;

  // Superadmin bypass (platform-wide, consistent with requireRole/etc.).
  if (principal.roles.some((r) => SUPERADMIN_BYPASS_ROLES.has(r))) return;

  let role: DatasetRole | null = null;
  let checkError: Error | null = null;
  try {
    // Lazy import: only the non-superadmin path touches the DB (foundryDb),
    // so importing authz.ts (and transitively datasetStore) never triggers
    // foundryDb's requireSecret at module load. Superadmin + kill-switch-off
    // never load it at all.
    const { DatasetAclService } = await import("../../datasetAcl.js");
    role = await new DatasetAclService().effectiveRole(datasetUuid, principal.userId, []);
  } catch (e) {
    checkError = e instanceof Error ? e : new Error(String(e));
  }

  // Fail-closed: a check error is NOT permission granted.
  if (checkError || !roleSatisfies(role, op)) {
    const outcome = checkError ? "error" : "deny";
    const reason = checkError
      ? `permission check failed: ${checkError.message}`
      : `insufficient role (got ${role ?? "none"}, need ${op === "read" ? "viewer+" : "editor+"})`;
    const labels = { dataset: datasetRid ?? datasetUuid, principal: principal.userId, op };
    try { incCounter("transform_authz_denials_total", labels); } catch { /* best-effort */ }
    if (checkError) {
      try { incCounter("transform_authz_check_errors_total", { op }); } catch { /* best-effort */ }
    }
    logger.warn({ msg: "transform dataset access denied", ...labels, outcome, reason });
    // Structured, queryable audit record (best-effort — never block on audit).
    // Lazy import: auditEventService loads foundryDb at module level; only the
    // deny path (rare) touches it, so importing authz never triggers the DB.
    try {
      const { emitAuditEventBestEffort } = await import("../../auditEventService.js");
      await emitAuditEventBestEffort({
        category: "object",
        action: op === "read" ? "transform.dataset.read" : "transform.dataset.write",
        keycloakSub: principal.userId,
        result: "FAILURE",
        details: { datasetRid: datasetRid ?? null, datasetUuid, op, outcome, principal: principal.userId, reason },
      });
    } catch { /* best-effort */ }
    // Throw an actual Error (not the transformError envelope object, which is
    // for HTTP-layer responses): the build/preview service layers catch this +
    // String(e) it into the build reason / preview ok:false message. The name
    // + parameters are attached so an HTTP layer can map it to a 403 if it
    // ever surfaces there.
    const err = new Error(`Transform:PermissionDenied: ${reason}`);
    (err as Error & { transformErrorName?: string; parameters?: Record<string, unknown> }).transformErrorName =
      "Transform:PermissionDenied";
    (err as Error & { parameters?: Record<string, unknown> }).parameters = {
      dataset: datasetRid ?? datasetUuid,
      operation: op,
      principal: principal.userId,
      reason,
    };
    throw err;
  }
}
