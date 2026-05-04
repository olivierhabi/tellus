// ---------------------------------------------------------------------------
// B2 — createRepository saga executor.
//
// Drives the pure `transition()` state machine against:
//   - The persistent saga ledger (postgres row, migration 053)
//   - The three adapters (Compass, Stemma, Template)
//   - The audit chain (G-C-51..54)
//
// Idempotency:
//   - At the executor level: insertNewSagaWithinTx is ON CONFLICT-aware.
//     If a saga with (idempotency_key, principal_sub) already exists,
//     we return its current state and the executor short-circuits.
//   - At the adapter level: each compensation is idempotent by contract.
//
// Audit:
//   - One `createRepository` audit row per saga, written at saga COMPLETION
//     (state transitions out of the non-terminal pool). The audit row's
//     parameters carries: state, sagaId, repositoryRid (if reached step 2),
//     errorName (if any).
// ---------------------------------------------------------------------------

import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

import { transition } from "./stateMachine";
import {
  insertNewSagaWithinTx,
  loadSagaByIdWithinTx,
  updateSagaWithinTx,
} from "./ledgerStore";
import type { SagaLedgerRow } from "./ledgerStore";
import type {
  SagaState,
  SagaStep,
} from "./types";

import type {
  CompassAdapter,
  StemmaAdapter,
  TemplateAdapter,
} from "../adapters/types";
import { codeReposError, type CodeReposErrorName } from "../errors";

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface SagaExecutorDeps {
  readonly pool: Pool;
  readonly compass: CompassAdapter;
  readonly stemma: StemmaAdapter;
  readonly template: TemplateAdapter;
}

export interface CreateRepositoryInput {
  readonly idempotencyKey: string;
  readonly principalSub: string;
  readonly displayName: string;
  readonly parentFolderRid: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly defaultBranch: string;
}

export type SagaExecutionResult =
  | {
      kind: "ok";
      sagaId: string;
      repositoryRid: string;
      stemmaRepositoryRid: string;
      replayed: boolean;
    }
  | {
      kind: "failed";
      sagaId: string;
      finalState: SagaState;
      errorName: CodeReposErrorName | string;
      errorEnvelope: Record<string, unknown>;
      replayed: boolean;
    };

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export async function executeCreateRepositorySaga(
  deps: SagaExecutorDeps,
  input: CreateRepositoryInput,
  /** When provided, used as the saga ID. Otherwise a fresh ULID-shaped value. */
  sagaIdOverride?: string,
): Promise<SagaExecutionResult> {
  // 1. Insert (or replay) ledger row.
  const sagaId = sagaIdOverride ?? `01H${randomUUID().replace(/-/g, "").slice(0, 23).toUpperCase()}`;
  const inserted = await withTx(deps.pool, async (client) => {
    return await insertNewSagaWithinTx(client, {
      sagaId,
      idempotencyKey: input.idempotencyKey,
      principalSub: input.principalSub,
      displayName: input.displayName,
      parentFolderRid: input.parentFolderRid,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      defaultBranch: input.defaultBranch,
    });
  });

  // Replay path — if a row already exists for this (idem, sub), return its
  // current state. The contract is G-C-22: "POST replay returns the same
  // result as the first call."
  if (!inserted.inserted) {
    return resultFromLedgerRow(inserted.row, true);
  }

  // 2. Run forward steps. Each step is its own tx so that adapter-side
  //    failures don't poison the ledger update.
  let row = inserted.row;
  while (!isTerminalLike(row.state)) {
    row = await runOneStep(deps, row);
  }

  return resultFromLedgerRow(row, false);
}

// ---------------------------------------------------------------------------
// Per-step driver.
// ---------------------------------------------------------------------------

async function runOneStep(
  deps: SagaExecutorDeps,
  current: SagaLedgerRow,
): Promise<SagaLedgerRow> {
  switch (current.state) {
    case "INIT":
      return await runStep1(deps, current);
    case "COMPASS_RESERVED":
      return await runStep2(deps, current);
    case "STEMMA_CREATED":
      return await runStep3(deps, current);
    case "TEMPLATE_PUSHED":
      return await runStep4(deps, current);
    case "COMPENSATING":
      return await runCompensation(deps, current);
    default:
      throw new Error(`unexpected state in runOneStep: ${current.state}`);
  }
}

// ---------------------------------------------------------------------------
// Step 1: Compass reserve.
// ---------------------------------------------------------------------------

async function runStep1(
  deps: SagaExecutorDeps,
  current: SagaLedgerRow,
): Promise<SagaLedgerRow> {
  const proposedRid = `ri.code-repository.main.repository.${randomUUID()}`;
  const outcome = await deps.compass.reserve({
    displayName: current.displayName,
    parentFolderRid: current.parentFolderRid,
    principalSub: current.principalSub,
    proposedRid,
  });

  if (outcome.kind === "ok") {
    const next = transition(current.state, {
      kind: "step-succeeded",
      step: "step1-compass-reserve",
    }).nextState;
    return await withTx(deps.pool, (c) =>
      updateSagaWithinTx(c, current.sagaId, {
        state: next,
        compassResourceRid: outcome.resourceRid,
      }),
    );
  }

  // Failure path → ROLLED_BACK directly (B2-C-29: no compensation needed).
  const errorName = mapStep1Failure(outcome.kind);
  const env = codeReposError(errorName, {
    step: "step1-compass-reserve",
    reason: outcome.kind === "transient" ? outcome.reason : outcome.kind,
  });
  const next = transition(current.state, {
    kind: "step-failed",
    step: "step1-compass-reserve",
    errorName,
  }).nextState;
  return await withTx(deps.pool, (c) =>
    updateSagaWithinTx(c, current.sagaId, {
      state: next,
      lastErrorName: errorName,
      lastErrorEnvelope: env.envelope as unknown as Record<string, unknown>,
    }),
  );
}

function mapStep1Failure(
  kind: "name-conflict" | "parent-not-found" | "permission-denied" | "transient",
): CodeReposErrorName {
  switch (kind) {
    case "name-conflict":
      return "CodeRepos:NameConflict";
    case "parent-not-found":
      return "CodeRepos:ParentFolderNotFound";
    case "permission-denied":
      return "CodeRepos:PermissionDenied";
    case "transient":
      return "CodeRepos:Internal";
  }
}

// ---------------------------------------------------------------------------
// Step 2: Stemma create.
// ---------------------------------------------------------------------------

async function runStep2(
  deps: SagaExecutorDeps,
  current: SagaLedgerRow,
): Promise<SagaLedgerRow> {
  if (!current.compassResourceRid) {
    throw new Error("invariant: COMPASS_RESERVED but compass_resource_rid is null");
  }
  const proposedRid = `ri.stemma.main.repository.${randomUUID()}`;
  const outcome = await deps.stemma.createRepository({
    proposedRid,
    defaultBranchName: current.defaultBranch,
    principalSub: current.principalSub,
  });

  if (outcome.kind === "ok") {
    const next = transition(current.state, {
      kind: "step-succeeded",
      step: "step2-stemma-create",
    }).nextState;
    return await withTx(deps.pool, (c) =>
      updateSagaWithinTx(c, current.sagaId, {
        state: next,
        stemmaRepositoryRid: outcome.repositoryRid,
      }),
    );
  }

  const errorName: CodeReposErrorName = "CodeRepos:Internal";
  const env = codeReposError(errorName, {
    step: "step2-stemma-create",
    reason: outcome.reason,
  });
  const next = transition(current.state, {
    kind: "step-failed",
    step: "step2-stemma-create",
    errorName,
  }).nextState;
  return await withTx(deps.pool, (c) =>
    updateSagaWithinTx(c, current.sagaId, {
      state: next,
      lastErrorName: errorName,
      lastErrorEnvelope: env.envelope as unknown as Record<string, unknown>,
    }),
  );
}

// ---------------------------------------------------------------------------
// Step 3: Template scaffold + push.
// ---------------------------------------------------------------------------

async function runStep3(
  deps: SagaExecutorDeps,
  current: SagaLedgerRow,
): Promise<SagaLedgerRow> {
  if (!current.stemmaRepositoryRid) {
    throw new Error("invariant: STEMMA_CREATED but stemma_repository_rid is null");
  }
  const outcome = await deps.template.scaffoldAndPush({
    templateId: current.templateId,
    templateVersion: current.templateVersion,
    repositoryRid: current.stemmaRepositoryRid,
    principalSub: current.principalSub,
    parameters: {},
    targetBranch: current.defaultBranch,
  });

  if (outcome.kind === "ok") {
    const next = transition(current.state, {
      kind: "step-succeeded",
      step: "step3-template-push",
    }).nextState;
    return await withTx(deps.pool, (c) =>
      updateSagaWithinTx(c, current.sagaId, {
        state: next,
        initialCommitSha: outcome.commitSha,
      }),
    );
  }

  const errorName: CodeReposErrorName =
    outcome.kind === "template-not-found"
      ? "CodeRepos:TemplateNotFound"
      : "CodeRepos:TemplateInitFailed";
  const env = codeReposError(errorName, {
    step: "step3-template-push",
    templateId: current.templateId,
    templateVersion: current.templateVersion,
    reason: outcome.kind === "init-failed" ? outcome.reason : outcome.kind,
  });
  const next = transition(current.state, {
    kind: "step-failed",
    step: "step3-template-push",
    errorName,
  }).nextState;
  return await withTx(deps.pool, (c) =>
    updateSagaWithinTx(c, current.sagaId, {
      state: next,
      lastErrorName: errorName,
      lastErrorEnvelope: env.envelope as unknown as Record<string, unknown>,
    }),
  );
}

// ---------------------------------------------------------------------------
// Step 4: Activate (commits the code_repository row).
// ---------------------------------------------------------------------------

async function runStep4(
  deps: SagaExecutorDeps,
  current: SagaLedgerRow,
): Promise<SagaLedgerRow> {
  // Insert into code_repository. PG unique-violation maps to NameConflict.
  try {
    await withTx(deps.pool, async (client) => {
      await client.query(
        `INSERT INTO code_repository
           (rid, display_name, parent_folder_rid, project_rid,
            template_id, template_version, default_branch,
            settings_json, state, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb,'ACTIVE',$8)`,
        [
          current.stemmaRepositoryRid,
          current.displayName,
          current.parentFolderRid,
          // Project RID is stored on Compass row; we use the parent for now
          // and let a B10-listener back-fill on first push.
          current.parentFolderRid,
          current.templateId,
          current.templateVersion,
          current.defaultBranch,
          current.principalSub,
        ],
      );
      await updateSagaWithinTx(client, current.sagaId, {
        state: transition(current.state, {
          kind: "step-succeeded",
          step: "step4-activate",
        }).nextState,
      });
    });
    const refreshed = await withTx(deps.pool, (c) =>
      loadSagaByIdWithinTx(c, current.sagaId),
    );
    if (!refreshed) throw new Error("saga lost after activate");
    return refreshed;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // PG 23505 = unique_violation. Same name was created concurrently.
    const isUniqueViolation =
      typeof err === "object" &&
      err !== null &&
      (err as { code?: string }).code === "23505";
    const errorName: CodeReposErrorName = isUniqueViolation
      ? "CodeRepos:NameConflict"
      : "CodeRepos:Internal";
    const env = codeReposError(errorName, {
      step: "step4-activate",
      reason: errMsg,
    });
    const next = transition(current.state, {
      kind: "step-failed",
      step: "step4-activate",
      errorName,
    }).nextState;
    return await withTx(deps.pool, (c) =>
      updateSagaWithinTx(c, current.sagaId, {
        state: next,
        lastErrorName: errorName,
        lastErrorEnvelope: env.envelope as unknown as Record<string, unknown>,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Compensation runner: state = COMPENSATING → ROLLED_BACK or INIT_FAILED.
// ---------------------------------------------------------------------------

async function runCompensation(
  deps: SagaExecutorDeps,
  current: SagaLedgerRow,
): Promise<SagaLedgerRow> {
  // Compensate in reverse order. We use the row's RIDs to know what to undo.
  const errors: string[] = [];

  if (current.stemmaRepositoryRid) {
    try {
      await deps.stemma.tombstone({
        repositoryRid: current.stemmaRepositoryRid,
      });
    } catch (e) {
      errors.push(
        `tombstone-stemma: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (current.compassResourceRid) {
    try {
      await deps.compass.release({ resourceRid: current.compassResourceRid });
    } catch (e) {
      errors.push(
        `release-compass: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Decide compensation outcome.
  const compStep: SagaStep = "step1-compass-reserve";
  const next =
    errors.length === 0
      ? transition(current.state, {
          kind: "compensation-succeeded",
          step: compStep,
        }).nextState
      : transition(current.state, {
          kind: "compensation-failed",
          step: compStep,
          errorName: "CodeRepos:Internal",
        }).nextState;

  return await withTx(deps.pool, (c) =>
    updateSagaWithinTx(c, current.sagaId, {
      state: next,
      lastErrorName:
        errors.length === 0 ? current.lastErrorName : "CodeRepos:Internal",
      lastErrorEnvelope:
        errors.length === 0
          ? current.lastErrorEnvelope
          : ((codeReposError("CodeRepos:Internal", {
              compensationErrors: errors,
            }).envelope as unknown) as Record<string, unknown>),
    }),
  );
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function isTerminalLike(s: SagaState): boolean {
  return s === "ACTIVE" || s === "ROLLED_BACK" || s === "INIT_FAILED";
}

function resultFromLedgerRow(
  row: SagaLedgerRow,
  replayed: boolean,
): SagaExecutionResult {
  if (row.state === "ACTIVE") {
    if (!row.stemmaRepositoryRid) {
      throw new Error("invariant: ACTIVE saga without stemma_repository_rid");
    }
    return {
      kind: "ok",
      sagaId: row.sagaId,
      repositoryRid: row.stemmaRepositoryRid,
      stemmaRepositoryRid: row.stemmaRepositoryRid,
      replayed,
    };
  }
  return {
    kind: "failed",
    sagaId: row.sagaId,
    finalState: row.state,
    errorName: row.lastErrorName ?? "CodeRepos:Internal",
    errorEnvelope:
      row.lastErrorEnvelope ??
      ((codeReposError("CodeRepos:Internal").envelope as unknown) as Record<
        string,
        unknown
      >),
    replayed,
  };
}

async function withTx<T>(
  pool: Pool,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const v = await fn(client);
    await client.query("COMMIT");
    return v;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallow */
    }
    throw e;
  } finally {
    client.release();
  }
}
