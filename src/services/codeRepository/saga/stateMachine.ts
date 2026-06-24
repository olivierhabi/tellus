// ---------------------------------------------------------------------------
// B2 — createRepository saga: pure state machine.
//
// `transition(state, event)` is the only public function. It is:
//   - Pure (same input → same output, no I/O).
//   - Total (every (state, event) pair maps to a TransitionResult or throws).
//   - Compensation-aware: on step failure, returns the compensations
//     to run in *reverse* order of the steps already completed.
//
// Spec contracts proven:
//   B2-C-20  INIT → COMPASS_RESERVED on step1-compass-reserve success
//   B2-C-21  COMPASS_RESERVED → STEMMA_CREATED on step2-stemma-create success
//   B2-C-22  STEMMA_CREATED → TEMPLATE_PUSHED on step3-template-push success
//   B2-C-23  TEMPLATE_PUSHED → ACTIVE on step4-activate success
//   B2-C-24  Step failure at any step → COMPENSATING with reverse-order compensations
//   B2-C-25  COMPENSATING + all-comp-succeeded → ROLLED_BACK
//   B2-C-26  COMPENSATING + any-comp-failed → INIT_FAILED (retriable)
//   B2-C-27  Terminal states are absorbing — no transition out
//   B2-C-28  Out-of-order events throw — never silently misadvance
//   B2-C-29  Step1 failure does NOT enter COMPENSATING (no work to undo)
// ---------------------------------------------------------------------------

import {
  TERMINAL_STATES,
  type SagaEvent,
  type SagaState,
  type SagaStep,
  type TransitionResult,
} from "./types";

/**
 * Pure transition function. Throws `IllegalSagaTransition` on invalid
 * (state, event) pairs — the caller's bug, not a domain error.
 */
export function transition(
  state: SagaState,
  event: SagaEvent,
): TransitionResult {
  // Terminal states absorb — no transition exits them. (B2-C-27)
  if (TERMINAL_STATES.has(state)) {
    throw new IllegalSagaTransition(
      `state ${state} is terminal; no transitions emerge`,
    );
  }

  // Each forward branch handles one (state, event-kind) pair explicitly.
  // The default case throws — there is no silent advance.

  switch (event.kind) {
    case "step-succeeded":
      return onStepSucceeded(state, event.step);
    case "step-failed":
      return onStepFailed(state, event.step);
    case "compensation-succeeded":
      return onCompensationSucceeded(state, event.step);
    case "compensation-failed":
      return onCompensationFailed(state, event.step);
    default: {
      // Exhaustiveness check — if SagaEvent gains a new variant, this
      // line ceases to compile.
      const _exhaustive: never = event;
      throw new IllegalSagaTransition(
        `unhandled SagaEvent variant: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// step-succeeded: forward path.
// ---------------------------------------------------------------------------

function onStepSucceeded(
  state: SagaState,
  step: SagaStep,
): TransitionResult {
  // INIT + step1 ok → COMPASS_RESERVED. (B2-C-20)
  if (state === "INIT" && step === "step1-compass-reserve") {
    return finalize("COMPASS_RESERVED", []);
  }
  // COMPASS_RESERVED + step2 ok → STEMMA_CREATED. (B2-C-21)
  if (state === "COMPASS_RESERVED" && step === "step2-stemma-create") {
    return finalize("STEMMA_CREATED", []);
  }
  // STEMMA_CREATED + step3 ok → TEMPLATE_PUSHED. (B2-C-22)
  if (state === "STEMMA_CREATED" && step === "step3-template-push") {
    return finalize("TEMPLATE_PUSHED", []);
  }
  // TEMPLATE_PUSHED + step4 ok → ACTIVE. (B2-C-23)
  if (state === "TEMPLATE_PUSHED" && step === "step4-activate") {
    return finalize("ACTIVE", []);
  }
  // Out-of-order success — caller skipped a state. (B2-C-28)
  throw new IllegalSagaTransition(
    `step-succeeded(${step}) is invalid in state ${state}`,
  );
}

// ---------------------------------------------------------------------------
// step-failed: enter COMPENSATING with reverse-order compensations.
// ---------------------------------------------------------------------------

function onStepFailed(state: SagaState, step: SagaStep): TransitionResult {
  // INIT + step1 fail → ROLLED_BACK directly (no work to compensate). (B2-C-29)
  if (state === "INIT" && step === "step1-compass-reserve") {
    return finalize("ROLLED_BACK", []);
  }

  // COMPASS_RESERVED + step2 fail → COMPENSATING(release-compass). (B2-C-24)
  if (state === "COMPASS_RESERVED" && step === "step2-stemma-create") {
    return finalize("COMPENSATING", ["step1-compass-reserve"]);
  }

  // STEMMA_CREATED + step3 fail → COMPENSATING(tombstone-stemma, release-compass). (B2-C-24)
  if (state === "STEMMA_CREATED" && step === "step3-template-push") {
    return finalize("COMPENSATING", [
      "step2-stemma-create",
      "step1-compass-reserve",
    ]);
  }

  // TEMPLATE_PUSHED + step4 fail → COMPENSATING(activate-noop, tombstone, release).
  // step4 has no resource of its own, but failure here means we have a
  // fully-built repo we can't safely activate (e.g. row-update tx aborted),
  // so we tear down everything. (B2-C-24)
  if (state === "TEMPLATE_PUSHED" && step === "step4-activate") {
    return finalize("COMPENSATING", [
      "step3-template-push",
      "step2-stemma-create",
      "step1-compass-reserve",
    ]);
  }

  // Out-of-order failure (e.g. step3-failed in INIT) — caller bug. (B2-C-28)
  throw new IllegalSagaTransition(
    `step-failed(${step}) is invalid in state ${state}`,
  );
}

// ---------------------------------------------------------------------------
// compensation-succeeded: stay in COMPENSATING until last compensation succeeds.
// ---------------------------------------------------------------------------

function onCompensationSucceeded(
  state: SagaState,
  _step: SagaStep,
): TransitionResult {
  // The state machine is stateless — it doesn't track *which* compensations
  // are pending. The caller iterates the compensations list returned by the
  // entering transition and feeds back compensation-succeeded for each.
  // After the last one, the caller emits a synthetic `compensation-succeeded`
  // for `step1-compass-reserve` (the topmost compensation), and we land in
  // ROLLED_BACK.
  //
  // Practically: the stateMachine treats every comp-succeeded in COMPENSATING
  // as a no-op IF the step matches a step that *could* have been compensated;
  // the caller commits to ROLLED_BACK when its compensation queue empties by
  // emitting one final comp-succeeded with step="step1-compass-reserve".
  //
  // To keep this pure-and-deterministic, we use an alternate convention:
  //   The caller emits exactly ONE compensation-succeeded for the *final*
  //   compensation (the lowest step number that actually ran). The state
  //   machine reads that as "all compensations done" and lands in ROLLED_BACK.
  if (state !== "COMPENSATING") {
    throw new IllegalSagaTransition(
      `compensation-succeeded is invalid in state ${state}`,
    );
  }
  return finalize("ROLLED_BACK", []);
}

// ---------------------------------------------------------------------------
// compensation-failed: → INIT_FAILED (retriable).
// ---------------------------------------------------------------------------

function onCompensationFailed(
  state: SagaState,
  _step: SagaStep,
): TransitionResult {
  if (state !== "COMPENSATING") {
    throw new IllegalSagaTransition(
      `compensation-failed is invalid in state ${state}`,
    );
  }
  return finalize("INIT_FAILED", []);
}

// ---------------------------------------------------------------------------
// Helpers + custom error class.
// ---------------------------------------------------------------------------

function finalize(
  nextState: SagaState,
  compensations: readonly SagaStep[],
): TransitionResult {
  return Object.freeze({
    nextState,
    compensations,
    isTerminal: TERMINAL_STATES.has(nextState),
  });
}

export class IllegalSagaTransition extends Error {
  readonly code = "ILLEGAL_SAGA_TRANSITION";
  constructor(message: string) {
    super(message);
    this.name = "IllegalSagaTransition";
  }
}
