// =============================================================================
// B10 — Workshop Action Validate + Apply
//
// Spec §B10:
//   - validate(p) returns the same shape as apply(p).validation (testable
//     property: ∀ p. validate(p) == apply(p).validation)
//   - apply requires Idempotency-Key (UUID v4); same key + same body →
//     cached response; same key + different body → 409 IdempotencyKeyReused
//   - apply returns ActionApplyResponse with edits.modifiedProperties
//   - StaleObjectError → 409 Tellus:Workshop:ActionStaleObject; client MUST
//     NOT auto-retry (per spec; route returns the envelope, no retry header)
//   - Audit row emitted on every successful apply
// =============================================================================

import {
  type ActionApplyRequest,
  type ActionApplyResponse,
  type ActionValidationResult,
  getActions,
  StaleObjectError,
} from "./actionsAdapter.js";
import type { OssRequestContext } from "./ossAdapter.js";
import { workshopError } from "./errors.js";
import {
  histApply,
  counterApply,
  counterStaleObject,
} from "./metrics.js";
import { withTimeout, getActionsTimeoutMs } from "./timeouts.js";

/**
 * Validate-only path. Identical signature/return shape to the validation
 * phase that runs inside `apply` — guaranteed by the adapter contract.
 */
export async function validate(
  req: ActionApplyRequest,
  ctx: OssRequestContext,
): Promise<ActionValidationResult> {
  const t0 = process.hrtime.bigint();
  let result: "success" | "error" = "success";
  try {
    return await withTimeout(
      getActions().validate(req, ctx),
      getActionsTimeoutMs(),
      "actions",
    );
  } catch (e) {
    result = "error";
    throw e;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histApply.observe({ phase: "validate", result }, ns / 1e9);
    counterApply.inc({ phase: "validate", status: result }, 1);
  }
}

/**
 * Apply path. Wraps the adapter's apply with stale-object → workshop-error
 * mapping. Idempotency lookup happens at the route layer (see
 * routes/workshopModules.ts) because it requires HTTP context.
 */
export async function apply(
  req: ActionApplyRequest,
  ctx: OssRequestContext,
): Promise<ActionApplyResponse> {
  const t0 = process.hrtime.bigint();
  let result: "success" | "error" = "success";
  try {
    const out = await withTimeout(
      getActions().apply(req, ctx),
      getActionsTimeoutMs(),
      "actions",
    );
    return out;
  } catch (err) {
    result = "error";
    if (err instanceof StaleObjectError) {
      counterStaleObject.inc(undefined, 1);
      throw workshopError({
        errorName: "Tellus:Workshop:ActionStaleObject",
        status: 409,
        parameters: {
          objectTypeApiName: err.objectTypeApiName,
          primaryKey: err.primaryKey,
          expectedVersion: err.expectedVersion,
          actualVersion: err.actualVersion,
        },
      });
    }
    throw err;
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    histApply.observe({ phase: "apply", result }, ns / 1e9);
    counterApply.inc({ phase: "apply", status: result }, 1);
  }
}
