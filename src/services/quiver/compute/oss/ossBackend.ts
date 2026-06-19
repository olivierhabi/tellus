/**
 * B6 — `OssObjectSetBackend` adapter.
 *
 * Maps the 6 OSS-bound card types onto `OssPort` calls, with limits
 * enforcement, branch propagation, deadline forwarding (G-06), and
 * permission gating for ACTION_BUTTON.
 */

import type { CardBackend, BackendExecuteInput, BackendExecuteOutput } from "../types";
import {
  ActionApplyForbiddenError,
  OssLimitExceededError,
  type AggregationMode,
  type AggregationSpec,
  type ObjectSetDefinition,
  type OssCallContext,
  type OssPort,
  type TransformTable,
} from "./ossPort";

const OSV1_INPUT_LIMIT = 100_000;
const RESULT_LIMIT_OSV2 = 10_000_000;

export class OssBackend implements CardBackend {
  constructor(public readonly cardType: string, private readonly port: OssPort) {}
  readonly backendName = "OSS" as const;

  async execute(input: BackendExecuteInput): Promise<BackendExecuteOutput> {
    const ctx: OssCallContext = {
      branch: input.branch,
      remainingMs: input.remainingMs,
      // ACTION_BUTTON path needs the user; the route plumbs the authed
      // subject through ComputeCardRequest.userSubject → BackendExecuteInput.
      // Test fallback: parameterOverrides.__user__ for unit-test convenience.
      userSubject:
        input.userSubject ??
        ((input.parameterOverrides as any).__user__ as string | undefined),
    };
    switch (this.cardType) {
      case "OBJECT_SET":           return this.executeObjectSet(input, ctx);
      case "FILTER_OBJECT_SET":    return this.executeFilter(input, ctx);
      case "SEARCH_AROUND":        return this.executeSearchAround(input, ctx);
      case "AGGREGATION":          return this.executeAggregation(input, ctx);
      case "PROPERTY_VALUE_SELECT": return this.executePropertyValueSelect(input, ctx);
      case "ACTION_BUTTON":        return this.executeActionButton(input, ctx);
      default:
        throw new Error(`OssBackend: unsupported cardType ${this.cardType}`);
    }
  }

  private definitionFromConfig(config: Record<string, unknown>): ObjectSetDefinition {
    const ontologyRid = String(config.ontologyRid ?? "ri.tellus.ontology.main.default");
    const objectSetRid = String(config.objectSetRid ?? "ri.tellus.object-set.main.default");
    return { kind: "named", ontologyRid, objectSetRid };
  }

  private async executeObjectSet(input: BackendExecuteInput, ctx: OssCallContext): Promise<BackendExecuteOutput> {
    const def = this.definitionFromConfig(input.config);
    const est = await this.port.estimateCardinality(def, ctx);
    if (est.storageGeneration === "OSv1" && est.rows > OSV1_INPUT_LIMIT) {
      throw new OssLimitExceededError("osv1_input", OSV1_INPUT_LIMIT, est.rows);
    }
    if (est.storageGeneration === "OSv2" && est.rows > RESULT_LIMIT_OSV2) {
      throw new OssLimitExceededError("osv2_result", RESULT_LIMIT_OSV2, est.rows);
    }
    const tmp = await this.port.createTemporaryObjectSet(def, ctx);
    return {
      resultType: "OBJECT_SET",
      payload: { kind: "temporary", temporaryRid: tmp, estimatedRows: est.rows, storageGeneration: est.storageGeneration, definition: def },
    };
  }

  private async executeFilter(input: BackendExecuteInput, ctx: OssCallContext): Promise<BackendExecuteOutput> {
    const upstreamSrc = this.findUpstream(input, "src");
    const def: ObjectSetDefinition = {
      kind: "filter",
      src: (upstreamSrc?.payload as any)?.definition ?? this.definitionFromConfig(input.config),
      predicate: (input.config as any).predicate ?? null,
    };
    const est = await this.port.estimateCardinality(def, ctx);
    if (est.storageGeneration === "OSv2" && est.rows > RESULT_LIMIT_OSV2) {
      throw new OssLimitExceededError("osv2_result", RESULT_LIMIT_OSV2, est.rows);
    }
    return {
      resultType: "OBJECT_SET",
      payload: { kind: "filtered", definition: def, estimatedRows: est.rows, storageGeneration: est.storageGeneration },
    };
  }

  private async executeSearchAround(input: BackendExecuteInput, ctx: OssCallContext): Promise<BackendExecuteOutput> {
    const upstreamSrc = this.findUpstream(input, "src");
    const linkApiName = String((input.config as any).linkApiName ?? "links.unknown");
    const baseDef: ObjectSetDefinition = (upstreamSrc?.payload as any)?.definition ?? this.definitionFromConfig(input.config);
    const result = await this.port.searchAround(baseDef, linkApiName, ctx);
    return {
      resultType: "OBJECT_SET",
      payload: { kind: "searchAround", definition: result.definition, estimatedRows: result.estimatedRows, storageGeneration: result.storageGeneration },
    };
  }

  private async executeAggregation(input: BackendExecuteInput, ctx: OssCallContext): Promise<BackendExecuteOutput> {
    const cfg = input.config as any;
    const upstreamSrc = this.findUpstream(input, "src");
    const def: ObjectSetDefinition = (upstreamSrc?.payload as any)?.definition ?? this.definitionFromConfig(cfg);
    const groupBy: string[] = Array.isArray(cfg.groupBy) ? cfg.groupBy.map(String) : [];
    const aggs: AggregationSpec[] = Array.isArray(cfg.aggregations) ? (cfg.aggregations as AggregationSpec[]) : [{ alias: "count", property: "*", op: "COUNT" }];
    if (aggs.length > 10) {
      throw new OssLimitExceededError("aggregation_groups", 10, aggs.length);
    }
    const mode: AggregationMode = cfg.aggregation?.mode === "PREFER_ACCURACY" ? "PREFER_ACCURACY" : "PREFER_SPEED";
    const table: TransformTable = await this.port.aggregateObjectSet(def, groupBy, aggs, mode, ctx);
    return {
      resultType: "TRANSFORM_TABLE",
      payload: table,
    };
  }

  private async executePropertyValueSelect(input: BackendExecuteInput, ctx: OssCallContext): Promise<BackendExecuteOutput> {
    const cfg = input.config as any;
    const upstreamSrc = this.findUpstream(input, "src");
    const def: ObjectSetDefinition = (upstreamSrc?.payload as any)?.definition ?? this.definitionFromConfig(cfg);
    const property = String(cfg.property ?? "name");
    const topN = Number(cfg.topN ?? 25);
    const r = await this.port.distinctPropertyValues(def, property, topN, ctx);
    return {
      resultType: "ARRAY_STRING",
      payload: r,
    };
  }

  private async executeActionButton(input: BackendExecuteInput, ctx: OssCallContext): Promise<BackendExecuteOutput> {
    const cfg = input.config as any;
    const actionApiName = String(cfg.actionApiName ?? "actions.unknown");
    const ifMatch = (cfg.ifMatch as string) ?? null;
    // B6 C-08 — gate via canApplyAction BEFORE delegating.
    const allowed = await this.port.canApplyAction(actionApiName, ctx);
    if (!allowed) {
      throw new ActionApplyForbiddenError(actionApiName, ctx.userSubject ?? "anonymous");
    }
    const result = await this.port.applyAction(actionApiName, (cfg.paramBindings as any) ?? {}, ifMatch, ctx);
    return {
      // ACTION_BUTTON has no declared dataset output; we emit a small status payload.
      resultType: "TRANSFORM_TABLE",
      payload: result,
    };
  }

  private findUpstream(input: BackendExecuteInput, slot: string): { payload: unknown } | undefined {
    // First entry whose value the planner attached → the result for that slot.
    // The executor passes upstreams as a Map<cardId, CardResult> keyed on the
    // upstream cardId, not the slot name; v1 simplifies by walking the map.
    void slot;
    const first = input.upstreamResults.values().next();
    if (first.done) return undefined;
    return { payload: (first.value as any).payload };
  }
}

/** Build the 6 OSS-bound CardBackends from a single OssPort. */
export function buildOssBackends(port: OssPort): CardBackend[] {
  return [
    new OssBackend("OBJECT_SET", port),
    new OssBackend("FILTER_OBJECT_SET", port),
    new OssBackend("SEARCH_AROUND", port),
    new OssBackend("AGGREGATION", port),
    new OssBackend("PROPERTY_VALUE_SELECT", port),
    new OssBackend("ACTION_BUTTON", port),
  ];
}
