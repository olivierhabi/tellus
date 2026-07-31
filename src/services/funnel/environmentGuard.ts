// ---------------------------------------------------------------------------
// FUNN-ISO — Deployment environment guard (the execution-context fence).
//
// Defense in depth for Temporal orchestration:
//
//   Layer 1 — namespace/task-queue isolation (config/environmentIdentity.ts).
//   Layer 2 — THIS module: a persistent, database-local environment seal
//             (`deployment_environment` — migration 150) plus a per-activity
//             fence that compares (a) the workflow execution context's
//             environment identity, (b) the running worker's configured
//             identity, and (c) the database's sealed identity. Any
//             divergence throws `FunnelExecutionEnvironmentMismatch` —
//             non-retryable, never converted to an empty result or a
//             successful no-op.
//
// Layer 2 exists because namespace isolation alone cannot protect against
// copied environment files, restored database dumps, port-forward mistakes,
// or a future operator pointing a worker at the wrong cluster. The 2026-07-31
// incident (activities of one workflow executing across tellus_db and
// tellus_automate_verify) is the exact failure class this fence makes
// impossible to perform silently.
// ---------------------------------------------------------------------------

import { query } from "../../db";
import {
  getEnvironmentIdentity,
  type EnvironmentIdentity,
} from "../../config/environmentIdentity";
import { recordEnvironmentMismatch } from "./isolationMetrics";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Non-retryable by contract: retrying cannot repair a worker that is wired
 * to the wrong database/environment. Temporal activities re-throw this as a
 * `nonRetryable` ApplicationFailure (see temporal/activities.ts) so stage
 * retry budgets are not wasted and the workflow surfaces the real cause.
 */
export class FunnelExecutionEnvironmentMismatch extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly source: "context_vs_worker" | "worker_vs_db" | "context_vs_db";
  constructor(
    source: FunnelExecutionEnvironmentMismatch["source"],
    expected: string,
    actual: string,
  ) {
    super(
      `deployment environment mismatch (${source}): expected='${expected}' actual='${actual}'. ` +
        `Refusing to execute — check TELLUS_ENVIRONMENT_ID / TEMPORAL_NAMESPACE / TEMPORAL_TASK_QUEUE ` +
        `on this worker and the deployment_environment seal of the connected database.`,
    );
    this.name = "FunnelExecutionEnvironmentMismatch";
    this.expected = expected;
    this.actual = actual;
    this.source = source;
  }
}

/** The workflow expected an object type that this environment cannot resolve. */
export class FunnelObjectTypeMissing extends Error {
  readonly objectTypeRid?: string;
  readonly objectTypeApiName?: string;
  constructor(objectTypeApiName: string | undefined, objectTypeRid: string | undefined) {
    super(
      `expected object type not resolvable in this environment ` +
        `(apiName='${objectTypeApiName ?? "?"}', rid='${objectTypeRid ?? "?"}') — ` +
        `either it was deleted or this activity executed against the wrong database.`,
    );
    this.name = "FunnelObjectTypeMissing";
    this.objectTypeApiName = objectTypeApiName;
    this.objectTypeRid = objectTypeRid;
  }
}

/** A stale run attempted to overwrite state owned by a newer run. */
export class FunnelStaleStateTransition extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunnelStaleStateTransition";
  }
}

// ---------------------------------------------------------------------------
// execution context carried through the workflow → activity boundary
// ---------------------------------------------------------------------------

export interface FunnelExecutionContext {
  environmentId: string;
  ontologyRid: string;
  objectTypeRid?: string;
  objectTypeApiName: string;
}

// ---------------------------------------------------------------------------
// Database seal
// ---------------------------------------------------------------------------

let cachedSeal: string | null | undefined; // undefined = not read yet

/**
 * Insert this database's environment seal if absent; VERIFY it matches the
 * process identity otherwise. "First writer wins" — a database can only ever
 * be claimed by one environment; re-sealing requires operator action.
 *
 * Throws `FunnelExecutionEnvironmentMismatch` when the seal exists and
 * disagrees, or plain Error when the table is missing (migration 150 not
 * applied — surfaced as an actionable message).
 */
export async function sealDatabaseEnvironment(
  identity: EnvironmentIdentity = getEnvironmentIdentity(),
): Promise<string> {
  const existing = await readDatabaseEnvironmentSeal().catch((err) => {
    throw new Error(
      `cannot read deployment_environment seal (migration 150 applied?): ${(err as Error).message}`,
    );
  });
  if (existing == null) {
    await query(
      `INSERT INTO deployment_environment (environment_id, sealed_by)
       VALUES ($1, $2)
       ON CONFLICT (singleton) DO NOTHING`,
      [identity.environmentId, "worker-boot"],
    );
    const after = await readDatabaseEnvironmentSeal(true);
    if (after && after !== identity.environmentId) {
      throwMismatch(identity.environmentId, after);
    }
    return after ?? identity.environmentId;
  }
  if (existing !== identity.environmentId) {
    throwMismatch(identity.environmentId, existing);
  }
  return existing;
}

function throwMismatch(expected: string, actual: string): never {
  recordEnvironmentMismatch({ source: "worker_vs_db", expected, actual });
  throw new FunnelExecutionEnvironmentMismatch("worker_vs_db", expected, actual);
}

async function readDatabaseEnvironmentSeal(bypassCache = false): Promise<string | null> {
  if (!bypassCache && cachedSeal !== undefined) return cachedSeal;
  const res = await query(
    `SELECT environment_id FROM deployment_environment WHERE singleton = TRUE LIMIT 1`,
  );
  cachedSeal = (res.rows[0]?.environment_id as string | undefined) ?? null;
  return cachedSeal;
}

/** Read-only seal accessor used by health checks and diagnostics. */
export async function getDatabaseEnvironmentId(): Promise<string | null> {
  try {
    return await readDatabaseEnvironmentSeal();
  } catch {
    return null; // table absent (pre-150) — report "unknown" rather than throw
  }
}

/** Test hook — clears the seal cache so tests can re-seal. */
export function __resetEnvironmentSealForTesting(): void {
  cachedSeal = undefined;
}

// ---------------------------------------------------------------------------
// The fence
// ---------------------------------------------------------------------------

/**
 * The execution-context fence. Every funnel activity calls this BEFORE any
 * read or write:
 *
 *   1. ctx.environmentId vs this worker's configured identity.
 *   2. this worker's configured identity vs the database's sealed identity.
 *
 * Both comparisons must hold; either failure throws
 * `FunnelExecutionEnvironmentMismatch` (non-retryable).
 */
export async function fenceExecutionContext(
  ctx: { environmentId?: string },
): Promise<{ dbEnvironmentId: string }> {
  const identity = getEnvironmentIdentity();
  // A missing environment identity on the context means the dispatch came
  // from a pre-FUNN-ISO (unfenced) code path — that is ITSELF a mismatch,
  // not something to tolerate.
  if (!ctx.environmentId || ctx.environmentId !== identity.environmentId) {
    recordEnvironmentMismatch({
      source: "context_vs_worker",
      expected: identity.environmentId,
      actual: ctx.environmentId ?? "<missing>",
    });
    throw new FunnelExecutionEnvironmentMismatch(
      "context_vs_worker",
      identity.environmentId,
      ctx.environmentId ?? "<missing>",
    );
  }
  const dbSeal = await readDatabaseEnvironmentSeal();
  if (dbSeal === null) {
    // Unsealed database — seal it now (first-writer-wins) so subsequent
    // activity invocations in every process are fenced against the seal.
    await sealDatabaseEnvironment(identity);
    return { dbEnvironmentId: identity.environmentId };
  }
  if (dbSeal !== identity.environmentId) {
    recordEnvironmentMismatch({
      source: "context_vs_db",
      expected: identity.environmentId,
      actual: dbSeal,
    });
    throw new FunnelExecutionEnvironmentMismatch(
      "context_vs_db",
      identity.environmentId,
      dbSeal,
    );
  }
  return { dbEnvironmentId: dbSeal };
}

// ---------------------------------------------------------------------------
// Object-type resolution with fail-closed semantics
// ---------------------------------------------------------------------------

export interface ResolvedObjectType {
  object_type_id: string;
  ontology_id: string;
  api_name: string;
}

/**
 * Resolve the object type the workflow expects. When `rid` is provided the
 * (ontologyId, apiName, rid) triple must be CONSISTENT — a mismatch (or
 * absence) is never a no-op: it throws `FunnelObjectTypeMissing` so the
 * workflow can transition the run to an explicit terminal state instead of
 * reporting a green "indexed" badge.
 */
export async function resolveExpectedObjectType(
  ctx: FunnelExecutionContext,
): Promise<ResolvedObjectType> {
  const res = await query(
    `SELECT object_type_id, ontology_id, api_name
       FROM object_type
      WHERE ontology_id = $1 AND api_name = $2
      LIMIT 1`,
    [ctx.ontologyRid, ctx.objectTypeApiName],
  );
  const row = res.rows[0] as ResolvedObjectType | undefined;
  if (!row) throw new FunnelObjectTypeMissing(ctx.objectTypeApiName, ctx.objectTypeRid);
  if (ctx.objectTypeRid && row.object_type_id !== ctx.objectTypeRid) {
    throw new FunnelObjectTypeMissing(ctx.objectTypeApiName, ctx.objectTypeRid);
  }
  return row;
}
