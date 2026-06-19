// ---------------------------------------------------------------------------
// Trino adapter — FOUNDRY-GAPS §1 (mirrors flinkAdapter.ts for batch).
//
// Implements the engine-neutral ComputeEngine contract over Trino's REST
// statement protocol (POST /v1/statement → follow nextUri until FINISHED).
// Two modes, selected by env exactly like the Flink adapter:
//   - "http": real coordinator at TRINO_URL (default http://localhost:8088)
//   - "noop": deterministic in-memory engine for tests / unconfigured envs
//
// The adapter never returns rows to Node — the compiled plan's final INSERT
// writes Iceberg through Trino's native connector against the Lakekeeper
// REST catalog (TRINO_CATALOG, default "iceberg"), so commits get catalog
// OCC for free and the PyIceberg sidecar is bypassed.
// ---------------------------------------------------------------------------

import { AppError } from "../../utils/foundryAppError";
import type {
  ComputeEngine,
  EnginePlan,
  EngineExecutionResult,
  IcebergTarget,
} from "./computeEngine";

export interface TrinoAdapterConfig {
  url: string;
  user: string;
  catalog: string;
  /** Per-statement poll budget (ms). */
  statementTimeoutMs: number;
}

export function trinoConfigFromEnv(): TrinoAdapterConfig {
  return {
    url: (process.env.TRINO_URL ?? "http://localhost:8088").replace(/\/+$/, ""),
    user: process.env.TRINO_USER ?? "tellus",
    catalog: process.env.TRINO_CATALOG ?? "iceberg",
    statementTimeoutMs: Number(
      process.env.TRINO_STATEMENT_TIMEOUT_MS ?? "1800000", // 30 min
    ),
  };
}

// ---------------------------------------------------------------------------
// Noop engine — deterministic, no network. Used by unit tests and as the
// safe default when TELLUS_BATCH_ENGINE=trino but TRINO_URL is unset.
// ---------------------------------------------------------------------------

export class NoopTrinoEngine implements ComputeEngine {
  readonly name = "trino-noop";
  /** Every executed plan, for test assertions. */
  readonly executed: Array<{ plan: EnginePlan; target: IcebergTarget }> = [];

  async available(): Promise<boolean> {
    return true;
  }

  async executePlan(
    plan: EnginePlan,
    target: IcebergTarget,
  ): Promise<EngineExecutionResult> {
    this.executed.push({ plan, target });
    return {
      engine: this.name,
      rowCount: 0,
      elapsedMs: 0,
      queryIds: plan.statements.map((_, i) => `noop_${i}`),
    };
  }
}

// ---------------------------------------------------------------------------
// HTTP engine — Trino REST statement protocol.
// ---------------------------------------------------------------------------

interface TrinoStatementState {
  id: string;
  nextUri?: string;
  stats?: { state?: string; elapsedTimeMillis?: number };
  error?: { message?: string; errorName?: string };
  updateCount?: number;
  data?: unknown[][];
}

export class HttpTrinoEngine implements ComputeEngine {
  readonly name = "trino";

  constructor(private readonly config: TrinoAdapterConfig = trinoConfigFromEnv()) {}

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.url}/v1/info`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const info = (await res.json()) as { starting?: boolean };
      return info.starting !== true;
    } catch {
      return false;
    }
  }

  async executePlan(
    plan: EnginePlan,
    _target: IcebergTarget,
  ): Promise<EngineExecutionResult> {
    const queryIds: string[] = [];
    let rowCount = 0;
    let elapsedMs = 0;

    for (const sql of plan.statements) {
      const result = await this.runStatement(sql);
      queryIds.push(result.id);
      rowCount = result.updateCount ?? rowCount;
      elapsedMs += result.elapsedMs;
    }

    return { engine: this.name, rowCount, elapsedMs, queryIds };
  }

  private async runStatement(
    sql: string,
  ): Promise<{ id: string; updateCount?: number; elapsedMs: number }> {
    const started = Date.now();
    const deadline = started + this.config.statementTimeoutMs;

    let state = await this.post(sql);
    let updateCount: number | undefined;

    while (state.nextUri) {
      if (Date.now() > deadline) {
        throw new AppError(
          `Trino statement exceeded ${this.config.statementTimeoutMs}ms (query ${state.id}).`,
          504,
          "TRINO_STATEMENT_TIMEOUT",
        );
      }
      state = await this.get(state.nextUri);
      if (typeof state.updateCount === "number") updateCount = state.updateCount;
      if (state.error) {
        throw new AppError(
          `Trino query ${state.id} failed: ${state.error.errorName ?? ""} ${state.error.message ?? ""}`.trim(),
          502,
          "TRINO_QUERY_FAILED",
        );
      }
      const s = state.stats?.state;
      if (s === "QUEUED" || s === "PLANNING") await sleep(200);
    }

    if (state.error) {
      throw new AppError(
        `Trino query ${state.id} failed: ${state.error.errorName ?? ""} ${state.error.message ?? ""}`.trim(),
        502,
        "TRINO_QUERY_FAILED",
      );
    }

    return {
      id: state.id,
      updateCount,
      elapsedMs: state.stats?.elapsedTimeMillis ?? Date.now() - started,
    };
  }

  private async post(sql: string): Promise<TrinoStatementState> {
    const res = await fetch(`${this.config.url}/v1/statement`, {
      method: "POST",
      headers: {
        "X-Trino-User": this.config.user,
        "X-Trino-Catalog": this.config.catalog,
        "X-Trino-Source": "tellus-pipeline-deploy",
        "Content-Type": "text/plain",
      },
      body: sql,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new AppError(
        `Trino coordinator rejected statement: HTTP ${res.status}`,
        502,
        "TRINO_SUBMIT_FAILED",
      );
    }
    return (await res.json()) as TrinoStatementState;
  }

  private async get(uri: string): Promise<TrinoStatementState> {
    const res = await fetch(uri, {
      headers: { "X-Trino-User": this.config.user },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      throw new AppError(
        `Trino poll failed: HTTP ${res.status}`,
        502,
        "TRINO_POLL_FAILED",
      );
    }
    return (await res.json()) as TrinoStatementState;
  }
}

// ---------------------------------------------------------------------------
// Registry — same test-seam pattern as getFlinkAdapter().
// ---------------------------------------------------------------------------

let overrideEngine: ComputeEngine | null = null;

export function setTrinoEngineForTests(engine: ComputeEngine | null): void {
  overrideEngine = engine;
}

export function getTrinoEngine(): ComputeEngine {
  if (overrideEngine) return overrideEngine;
  // http mode only when a coordinator is explicitly configured — mirrors the
  // Flink adapter's noop default so dev/test environments never dial out.
  return process.env.TRINO_URL ? new HttpTrinoEngine() : new NoopTrinoEngine();
}

/**
 * Whether a *real* Trino coordinator backs the engine path. The default
 * "auto" batch-engine mode keys off this: it engages the engine path only
 * when this is true, so a missing coordinator can never route through the
 * NoopTrinoEngine (which reports available but writes nothing). A test
 * override engine counts as configured so injected in-memory engines exercise
 * the engine path under "auto".
 */
export function trinoCoordinatorConfigured(): boolean {
  return overrideEngine !== null || !!process.env.TRINO_URL;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
