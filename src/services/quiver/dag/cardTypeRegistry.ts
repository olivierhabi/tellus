// Quiver B2 — Card Type Registry.
//
// Single source of truth (cross-checked at boot against
// `tasks/quiver/registry-fixture.md`). 26 entries, locked at the
// Starting Protocol of the drive. The list of types and their slot/output
// shapes is the contract that B5 backends and F5 plugins both consume.
//
// Type compatibility (B2 C-04 covariance):
//   OBJECT_SET ⊆ TRANSFORM_TABLE   (OBJECT_SET acceptable wherever TRANSFORM_TABLE is)
//   MATERIALIZATION ⊆ TRANSFORM_TABLE
//   ANY matches anything (used only by FUNCTION_CALL output resolution)

import type { CardType, OutputType } from "../types";

export type SlotType = OutputType | "BOOLEAN_FORMULA" | "AGG_SPEC" | "DURATION" | "AGG_OP" | "COMPARATOR" | "VEGA_SPEC" | "RID" | "JOIN_KIND" | "ARRAY_STRING" | "ARRAY_AGG_SPEC" | "ARRAY_TIME_SERIES_PLOT" | "MAP_STRING_ANY";

export interface InputSlotDecl {
  /** Accepted upstream output types (covariant). Empty = literal-typed slot. */
  acceptedTypes: readonly SlotType[];
  /** Declared optionality. Required slots must be bound at validate time. */
  optional?: boolean;
  /** Whether the slot accepts a *list* of upstream cards. */
  list?: boolean;
}

export interface CardTypeEntry {
  type: CardType;
  inputs: Record<string, InputSlotDecl>;
  /** Output type. `null` means none (e.g. ACTION_BUTTON). */
  output: OutputType | "ANY";
}

// ---- Helpers --------------------------------------------------------------
const TABLE_LIKE: SlotType[] = ["OBJECT_SET", "TRANSFORM_TABLE", "MATERIALIZATION"];

const REGISTRY_ARRAY: CardTypeEntry[] = [
  { type: "OBJECT_SET", inputs: {}, output: "OBJECT_SET" },
  {
    type: "FILTER_OBJECT_SET",
    inputs: {
      src: { acceptedTypes: ["OBJECT_SET"] },
      predicate: { acceptedTypes: ["BOOLEAN_FORMULA", "BOOLEAN"] },
    },
    output: "OBJECT_SET",
  },
  {
    type: "SEARCH_AROUND",
    inputs: {
      src: { acceptedTypes: ["OBJECT_SET"] },
      linkApiName: { acceptedTypes: ["STRING"] },
    },
    output: "OBJECT_SET",
  },
  {
    type: "AGGREGATION",
    inputs: {
      src: { acceptedTypes: ["OBJECT_SET"] },
      group: { acceptedTypes: ["ARRAY_STRING"] },
      agg: { acceptedTypes: ["ARRAY_AGG_SPEC"] },
    },
    output: "TRANSFORM_TABLE",
  },
  {
    type: "TRANSFORM_TABLE",
    inputs: { src: { acceptedTypes: TABLE_LIKE } },
    output: "TRANSFORM_TABLE",
  },
  {
    type: "MATERIALIZATION",
    inputs: {
      src: { acceptedTypes: ["OBJECT_SET", "TRANSFORM_TABLE"] },
    },
    output: "MATERIALIZATION",
  },
  {
    type: "JOIN_MATERIALIZATION",
    inputs: {
      left: { acceptedTypes: ["MATERIALIZATION"] },
      right: { acceptedTypes: ["MATERIALIZATION"] },
      on: { acceptedTypes: ["ARRAY_STRING"] },
      kind: { acceptedTypes: ["JOIN_KIND"] },
    },
    output: "MATERIALIZATION",
  },
  {
    // EXPRESSION's output is declared in card.config.declaredOutput; default ANY.
    type: "EXPRESSION",
    inputs: {},
    output: "ANY",
  },
  { type: "NUMERIC_FORMULA", inputs: {}, output: "NUMBER" },
  { type: "BOOLEAN_FORMULA", inputs: {}, output: "BOOLEAN" },
  {
    type: "TIME_SERIES_PLOT",
    inputs: {
      src: { acceptedTypes: ["OBJECT_SET"] },
      propertyApiName: { acceptedTypes: ["STRING"] },
    },
    output: "TIME_SERIES_PLOT",
  },
  {
    type: "TIME_SERIES_CHART",
    inputs: {
      plots: { acceptedTypes: ["ARRAY_TIME_SERIES_PLOT"] },
    },
    output: "TIME_SERIES_CHART",
  },
  {
    type: "ROLLING_AGGREGATE",
    inputs: {
      src: { acceptedTypes: ["TIME_SERIES_PLOT"] },
      window: { acceptedTypes: ["DURATION"] },
      op: { acceptedTypes: ["AGG_OP"] },
    },
    output: "TIME_SERIES_PLOT",
  },
  {
    type: "EVENT_SET",
    inputs: {
      src: { acceptedTypes: ["TIME_SERIES_PLOT"] },
      threshold: { acceptedTypes: ["NUMBER"] },
      op: { acceptedTypes: ["COMPARATOR"] },
    },
    output: "EVENT_SET",
  },
  { type: "TIME_SERIES_FORMULA", inputs: {}, output: "TIME_SERIES_PLOT" },
  {
    type: "CATEGORICAL_CHART",
    inputs: {
      src: { acceptedTypes: ["TRANSFORM_TABLE", "OBJECT_SET"] },
      x: { acceptedTypes: ["STRING"] },
      y: { acceptedTypes: ["STRING"] },
    },
    output: "CATEGORICAL_CHART",
  },
  {
    type: "PIVOT_TABLE",
    inputs: {
      src: { acceptedTypes: ["TRANSFORM_TABLE", "OBJECT_SET"] },
    },
    output: "TRANSFORM_TABLE",
  },
  {
    type: "VEGA_PLOT",
    inputs: {
      spec: { acceptedTypes: ["VEGA_SPEC"] },
      data: { acceptedTypes: ["TRANSFORM_TABLE", "OBJECT_SET"] },
    },
    output: "VEGA_PLOT",
  },
  { type: "PARAMETER_STRING", inputs: {}, output: "STRING" },
  { type: "PARAMETER_NUMBER", inputs: {}, output: "NUMBER" },
  { type: "PARAMETER_DATETIME", inputs: {}, output: "DATETIME" },
  { type: "PARAMETER_BOOLEAN", inputs: {}, output: "BOOLEAN" },
  {
    type: "PROPERTY_VALUE_SELECT",
    inputs: {
      src: { acceptedTypes: ["OBJECT_SET"] },
      propertyApiName: { acceptedTypes: ["STRING"] },
    },
    output: "STRING", // also commonly NUMBER per spec; widened in B6
  },
  {
    type: "ACTION_BUTTON",
    inputs: {
      actionApiName: { acceptedTypes: ["STRING"] },
      paramBindings: { acceptedTypes: ["MAP_STRING_ANY"] },
    },
    output: "NONE",
  },
  {
    type: "FUNCTION_CALL",
    inputs: {
      functionRid: { acceptedTypes: ["RID"] },
      paramBindings: { acceptedTypes: ["MAP_STRING_ANY"] },
    },
    output: "ANY",
  },
  {
    type: "VISUAL_FUNCTION_CALL",
    inputs: {
      visualFunctionRid: { acceptedTypes: ["RID"] },
      paramBindings: { acceptedTypes: ["MAP_STRING_ANY"] },
    },
    output: "ANY",
  },
];

const REGISTRY: ReadonlyMap<CardType, CardTypeEntry> = new Map(
  REGISTRY_ARRAY.map((e) => [e.type, e]),
);

if (REGISTRY.size !== 26) {
  throw new Error(
    `Card Type Registry must have exactly 26 entries; got ${REGISTRY.size}. ` +
      `Spec: tasks/quiver/registry-fixture.md.`,
  );
}

export function getCardType(t: CardType): CardTypeEntry | undefined {
  return REGISTRY.get(t);
}

export function listCardTypes(): readonly CardTypeEntry[] {
  return REGISTRY_ARRAY;
}

export function isOutputAcceptable(
  upstreamOutput: OutputType | "ANY",
  acceptedTypes: readonly SlotType[],
): boolean {
  if (upstreamOutput === "ANY") return true;
  if (acceptedTypes.includes(upstreamOutput as SlotType)) return true;
  // Covariance per B2 C-04.
  if (
    upstreamOutput === "OBJECT_SET" &&
    (acceptedTypes.includes("TRANSFORM_TABLE") ||
      acceptedTypes.includes("MATERIALIZATION"))
  ) {
    return true;
  }
  if (
    upstreamOutput === "MATERIALIZATION" &&
    acceptedTypes.includes("TRANSFORM_TABLE")
  ) {
    return true;
  }
  return false;
}
