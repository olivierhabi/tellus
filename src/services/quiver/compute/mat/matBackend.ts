/**
 * B7 — `MaterializationBackend`.
 *
 * Maps the 5 mat-bound card types onto `MatPort` calls with tier
 * selection (B7 C-02/C-03), branch propagation (B7 C-10, G-09),
 * deadline forwarding (G-06), Iceberg snapshot pinning (B7 C-06),
 * and result-size-based inline/blob handling (B7 C-07).
 */

import type {
  CardBackend,
  BackendExecuteInput,
  BackendExecuteOutput,
} from "../types";
import type { CalcitePlan } from "./calcitePlan";
import { canonicalisePlan } from "./calcitePlan";
import {
  MatLimitExceededError,
  type MatExecuteContext,
  type MatPort,
} from "./matPort";
import { matTierSelectionTotal } from "../../metrics";

export const MAT_CARD_TYPES = [
  "MATERIALIZATION",
  "JOIN_MATERIALIZATION",
  "EXPRESSION",
  "PIVOT_TABLE",
  "CATEGORICAL_CHART",
] as const;

export type MatCardType = (typeof MAT_CARD_TYPES)[number];

const POLARS_CELL_THRESHOLD_DEFAULT = 10_000_000;       // 10 M cells
const POLARS_MEMORY_BUDGET_DEFAULT  = 2 * 1024 * 1024 * 1024; // 2 GiB

const RESULT_INLINE_THRESHOLD_BYTES = 1024 * 1024; // 1 MiB

export interface TierSelection {
  readonly tier: "polars" | "spark";
  readonly reason: "fits-polars" | "exceeds-cells" | "exceeds-memory" | "forced-spark" | "forced-polars";
}

export function selectTier(
  est: { rows: number; cols: number; estMemoryBytes: number },
  config: { cellThreshold?: number; memoryBudgetBytes?: number; force?: "polars" | "spark" } = {},
): TierSelection {
  const cellThreshold = config.cellThreshold ?? POLARS_CELL_THRESHOLD_DEFAULT;
  const memoryBudget = config.memoryBudgetBytes ?? POLARS_MEMORY_BUDGET_DEFAULT;
  if (config.force === "polars") return { tier: "polars", reason: "forced-polars" };
  if (config.force === "spark")  return { tier: "spark",  reason: "forced-spark"  };
  const cells = est.rows * est.cols;
  if (cells > cellThreshold)        return { tier: "spark", reason: "exceeds-cells"  };
  if (est.estMemoryBytes > memoryBudget) return { tier: "spark", reason: "exceeds-memory" };
  return { tier: "polars", reason: "fits-polars" };
}

export class MaterializationBackend implements CardBackend {
  readonly backendName = "MMDP" as const;

  constructor(
    public readonly cardType: string,
    private readonly port: MatPort,
    private readonly opts: { cellThreshold?: number; memoryBudgetBytes?: number } = {},
  ) {}

  async execute(input: BackendExecuteInput): Promise<BackendExecuteOutput> {
    const planRaw = (input.config as any).plan as CalcitePlan | undefined;
    if (!planRaw || typeof planRaw !== "object" || !Array.isArray(planRaw.nodes)) {
      throw new Error(`MaterializationBackend(${this.cardType}): config.plan missing or malformed`);
    }
    const plan = canonicalisePlan(planRaw);

    const ctx: MatExecuteContext = {
      branch: input.branch,
      remainingMs: input.remainingMs,
      userSubject: input.userSubject ?? "test-user",
    };

    // 1. Pin Iceberg snapshots (B7 C-06)
    const icebergSnapshots = await this.port.pinSnapshots(plan, ctx);

    // 2. Estimate cardinality + select tier (B7 C-02/C-03)
    const est = await this.port.estimateCardinality(plan, ctx);
    const force = (input.config as any).forceTier as "polars" | "spark" | undefined;
    const tierPick = selectTier(est, { ...this.opts, force });
    matTierSelectionTotal.inc({ tier: tierPick.tier, reason: tierPick.reason });

    // 3. Execute (operation label drives the metrics histogram)
    const op = operationLabel(this.cardType);
    const result = tierPick.tier === "polars"
      ? await this.port.polarsExecute(plan, ctx)
      : await this.port.sparkExecute(plan, ctx);

    // 4. Inline vs. blob (B7 C-07)
    const inlineable = result.arrowBytes <= RESULT_INLINE_THRESHOLD_BYTES;
    const value = inlineable
      ? { kind: "inline", columns: result.columns, rows: result.rows }
      : {
          kind: "blob",
          uri: `ri.tellus.main.blob.${input.cardId}-${Date.now()}`,
          arrowBytes: result.arrowBytes,
        };

    return {
      resultType: resultTypeFor(this.cardType),
      payload: {
        value,
        meta: {
          tier: tierPick.tier,
          tierReason: tierPick.reason,
          operation: op,
          rows: result.rows.length,
          cols: result.columns.length,
          arrowBytes: result.arrowBytes,
          icebergSnapshots,
          plan,                         // recorded into mat_plan_json (B7 C-04/C-05)
        },
      },
      status: "OK",
    };
  }
}

function resultTypeFor(cardType: string): string {
  switch (cardType) {
    case "JOIN_MATERIALIZATION":
    case "MATERIALIZATION":
      return "TRANSFORM_TABLE";
    case "EXPRESSION":
      return "ANY";
    case "PIVOT_TABLE":
      return "PIVOT_TABLE";
    case "CATEGORICAL_CHART":
      return "CATEGORICAL_CHART";
    default:
      return "TRANSFORM_TABLE";
  }
}

function operationLabel(cardType: string): string {
  switch (cardType) {
    case "JOIN_MATERIALIZATION": return "join";
    case "EXPRESSION":           return "expression";
    case "PIVOT_TABLE":          return "pivot";
    case "CATEGORICAL_CHART":    return "chart";
    default:                     return "mat";
  }
}

export function buildMatBackends(port: MatPort, opts?: { cellThreshold?: number; memoryBudgetBytes?: number }): CardBackend[] {
  return MAT_CARD_TYPES.map((t) => new MaterializationBackend(t, port, opts));
}

export { MatLimitExceededError };
