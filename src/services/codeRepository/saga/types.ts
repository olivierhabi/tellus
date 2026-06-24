// ---------------------------------------------------------------------------
// B2 — createRepository saga: state types.
//
// Spec §B2 line 322:
//   "Repo creation is a 4-step saga: (1) Compass.createResource →
//    (2) Stemma.createRepository → (3) B3.scaffold → push initial commit →
//    (4) state = ACTIVE.
//    Steps 1–3 are compensable; on failure, the saga rolls back via
//    tombstoning. Idempotency key required."
//
// State machine (B2-C-20..29):
//
//                 createRepository(Idempotency-Key)
//                          │
//                       ┌──▼──┐
//                       │INIT │
//                       └──┬──┘
//                          │ Step 1: Compass.createResource
//                ┌─────────┼─────────┐
//                │         │         │
//          fail-rollback   ok        idempotency-replay
//                │         │
//                ▼         ▼
//          ┌───────┐   ┌────────────────┐
//          │FAILED │   │COMPASS_RESERVED│
//          └───────┘   └───────┬────────┘
//                              │ Step 2: Stemma.createRepository
//                ┌─────────────┼────────────┐
//                │             │            │
//                ▼             ▼            ▼
//        compensate(release)   ok         idempotency-replay
//                              │
//                              ▼
//                     ┌────────────────┐
//                     │STEMMA_CREATED  │
//                     └───────┬────────┘
//                             │ Step 3: B3.scaffold + push initial commit
//                ┌────────────┼─────────┐
//                │            │         │
//                ▼            ▼         ▼
//         compensate(         ok      idempotency-replay
//          tombstone Stemma,
//          release Compass)
//                             │
//                             ▼
//                    ┌────────────────┐
//                    │TEMPLATE_PUSHED │
//                    └───────┬────────┘
//                            │ Step 4: code_repository.state = ACTIVE
//                            ▼
//                       ┌────────┐
//                       │ ACTIVE │  (terminal — saga done)
//                       └────────┘
//
// Compensation chain on failure (B2-C-26):
//   STEMMA_CREATED  → COMPENSATING → tombstone Stemma → release Compass → ROLLED_BACK
//   COMPASS_RESERVED→ COMPENSATING → release Compass                    → ROLLED_BACK
//   INIT            → COMPENSATING → no-op                              → ROLLED_BACK
//
// Terminal states: ACTIVE, ROLLED_BACK, INIT_FAILED.
//
// INIT_FAILED is reached when Step 3 fails and compensation also fails
// (e.g. Stemma tombstone unavailable). Per spec line 309 it is **retriable
// via re-init**, not auto-rolled-back.
// ---------------------------------------------------------------------------

import type { ErrorEnvelope } from "../../codeRepos/contracts/errors";

// ---------------------------------------------------------------------------
// State enum.
// ---------------------------------------------------------------------------

export const SAGA_STATES = [
  "INIT",
  "COMPASS_RESERVED",
  "STEMMA_CREATED",
  "TEMPLATE_PUSHED",
  "ACTIVE",
  "COMPENSATING",
  "ROLLED_BACK",
  "INIT_FAILED",
] as const;

export type SagaState = (typeof SAGA_STATES)[number];

/** Set of terminal states — no further transitions emerge. */
export const TERMINAL_STATES: ReadonlySet<SagaState> = new Set<SagaState>([
  "ACTIVE",
  "ROLLED_BACK",
  "INIT_FAILED",
]);

export function isTerminal(s: SagaState): boolean {
  return TERMINAL_STATES.has(s);
}

// ---------------------------------------------------------------------------
// Saga step + outcome types.
// ---------------------------------------------------------------------------

/** Saga step identifiers — name aligns with the spec's step numbers. */
export const SAGA_STEPS = [
  "step1-compass-reserve",
  "step2-stemma-create",
  "step3-template-push",
  "step4-activate",
] as const;

export type SagaStep = (typeof SAGA_STEPS)[number];

/** Outcome of a saga step's `execute()` call. */
export type StepOutcome =
  | { kind: "ok" }
  | { kind: "idempotent-replay"; existingRid: string }
  | {
      kind: "failed";
      errorName: string;
      errorEnvelope: ErrorEnvelope;
      retryable: boolean;
    };

/** Outcome of a compensation call. */
export type CompensateOutcome =
  | { kind: "ok" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; errorName: string; reason: string };

// ---------------------------------------------------------------------------
// Transition events (inputs to the pure state machine).
// ---------------------------------------------------------------------------

export type SagaEvent =
  | { kind: "step-succeeded"; step: SagaStep }
  | { kind: "step-failed"; step: SagaStep; errorName: string }
  | { kind: "compensation-succeeded"; step: SagaStep }
  | { kind: "compensation-failed"; step: SagaStep; errorName: string };

// ---------------------------------------------------------------------------
// State persisted between transitions (B2 owns this — saga ledger row).
// ---------------------------------------------------------------------------

export interface SagaContext {
  readonly sagaId: string; // ULID
  readonly idempotencyKey: string;
  readonly principalSub: string; // UUID
  readonly displayName: string;
  readonly parentFolderRid: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly defaultBranch: string;
  /** RID minted during step 1; unset before COMPASS_RESERVED. */
  readonly compassResourceRid: string | null;
  /** RID minted during step 2; unset before STEMMA_CREATED. */
  readonly stemmaRepositoryRid: string | null;
  /** Initial commit sha minted during step 3; unset before TEMPLATE_PUSHED. */
  readonly initialCommitSha: string | null;
}

/** Result of feeding a state + event through the pure transition function. */
export interface TransitionResult {
  readonly nextState: SagaState;
  /** Compensations to perform, in order, if the transition lands in COMPENSATING. */
  readonly compensations: readonly SagaStep[];
  /** True if the next state is terminal (caller MUST stop transitioning). */
  readonly isTerminal: boolean;
}
