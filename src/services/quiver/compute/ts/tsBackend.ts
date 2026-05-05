/**
 * B8 — `TimeSeriesBackend`.
 *
 * Maps the 5 ts-bound card types onto `CodexPort` calls. Per spec §B8:
 *   - Per-axis hydration: a TIME_SERIES_CHART with N axes triggers N
 *     independent calls so axis-1 invalidation never blocks axis-2 (B8 C-03).
 *   - Cold hydration returns 202-style status with hydrationToken
 *     (B8 C-05); the route layer surfaces this as the actual 202 wire shape.
 *   - X-axis linking carries `xAxisGroupId` through to `payload.meta`
 *     (B8 C-04); backend does not group axes itself.
 *   - Display bucketing capped at 1000 (B8 C-02; enforced inside the port).
 */

import type {
  CardBackend,
  BackendExecuteInput,
  BackendExecuteOutput,
} from "../types";
import type {
  CodexCallContext,
  CodexPort,
  SeriesQuery,
  BucketOp,
  Comparator,
} from "./codexPort";

export const TS_CARD_TYPES = [
  "TIME_SERIES_PLOT",
  "TIME_SERIES_CHART",
  "ROLLING_AGGREGATE",
  "EVENT_SET",
  "TIME_SERIES_FORMULA",
] as const;

export type TsCardType = (typeof TS_CARD_TYPES)[number];

export interface AxisHydrationResult {
  readonly axisId: string;
  readonly state: "warm" | "cold";
  readonly hydrationToken?: string;
  readonly data?: unknown;
}

export class TimeSeriesBackend implements CardBackend {
  readonly backendName = "CODEX" as const;

  constructor(public readonly cardType: string, private readonly port: CodexPort) {}

  async execute(input: BackendExecuteInput): Promise<BackendExecuteOutput> {
    const ctx: CodexCallContext = { branch: input.branch, remainingMs: input.remainingMs };

    switch (this.cardType) {
      case "TIME_SERIES_CHART":     return this.executeChart(input, ctx);
      case "TIME_SERIES_PLOT":      return this.executePlot(input, ctx);
      case "ROLLING_AGGREGATE":     return this.executeRolling(input, ctx);
      case "EVENT_SET":             return this.executeEvents(input, ctx);
      case "TIME_SERIES_FORMULA":   return this.executeFormula(input, ctx);
      default:
        throw new Error(`Unsupported card type for TimeSeriesBackend: ${this.cardType}`);
    }
  }

  // -------- per-card-type --------------------------------------------------

  /**
   * TIME_SERIES_CHART — N independent axes, each with its own
   * `seriesQuery`. Per B8 C-03 we issue N independent `getSeries`
   * calls — failure of one axis does not poison the others.
   */
  private async executeChart(input: BackendExecuteInput, ctx: CodexCallContext): Promise<BackendExecuteOutput> {
    const cfg = input.config as { axes?: Array<{ id: string; query: SeriesQuery; xAxisGroupId?: string }> };
    const axes = cfg.axes ?? [];
    const settled = await Promise.all(
      axes.map(async (axis): Promise<AxisHydrationResult> => {
        const r = await this.port.getSeries(axis.query, ctx);
        if (r.kind === "warm") return { axisId: axis.id, state: "warm", data: r.data };
        return { axisId: axis.id, state: "cold", hydrationToken: r.hydrationToken };
      }),
    );
    const xAxisGroupId = axes[0]?.xAxisGroupId; // B8 C-04 — pass-through to renderer
    return {
      resultType: "TIME_SERIES_CHART",
      payload: { axes: settled, xAxisGroupId },
      status: settled.every((a) => a.state === "warm") ? "OK" : "PARTIAL",
    };
  }

  private async executePlot(input: BackendExecuteInput, ctx: CodexCallContext): Promise<BackendExecuteOutput> {
    const cfg = input.config as { query: SeriesQuery };
    const r = await this.port.getSeries(cfg.query, ctx);
    if (r.kind === "warm") {
      return { resultType: "SERIES", payload: { state: "warm", data: r.data }, status: "OK" };
    }
    return {
      resultType: "SERIES",
      payload: { state: "cold", hydrationToken: r.hydrationToken },
      status: "PARTIAL",
    };
  }

  private async executeRolling(input: BackendExecuteInput, ctx: CodexCallContext): Promise<BackendExecuteOutput> {
    const cfg = input.config as { queries: SeriesQuery[]; op: BucketOp; windowMs: number };
    const data = await this.port.aggregateSeries(cfg.queries, cfg.op, cfg.windowMs, ctx);
    return { resultType: "SERIES", payload: { state: "warm", data }, status: "OK" };
  }

  private async executeEvents(input: BackendExecuteInput, ctx: CodexCallContext): Promise<BackendExecuteOutput> {
    const cfg = input.config as { query: SeriesQuery; threshold: number; comparator: Comparator };
    const events = await this.port.detectEvents(cfg.query, cfg.threshold, cfg.comparator, ctx);
    return { resultType: "EVENT_SET", payload: { events }, status: "OK" };
  }

  private async executeFormula(input: BackendExecuteInput, ctx: CodexCallContext): Promise<BackendExecuteOutput> {
    // Formula is a typed combination of aggregateSeries calls; treat the
    // first axis as the formula's primary axis for v1.
    const cfg = input.config as { queries: SeriesQuery[]; op: BucketOp; windowMs: number };
    const data = await this.port.aggregateSeries(cfg.queries, cfg.op ?? "avg", cfg.windowMs ?? 60_000, ctx);
    return { resultType: "SERIES", payload: { state: "warm", data, derivedFromFormula: true }, status: "OK" };
  }
}

export function buildTsBackends(port: CodexPort): CardBackend[] {
  return TS_CARD_TYPES.map((t) => new TimeSeriesBackend(t, port));
}
