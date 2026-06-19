// B10.01 — Object Storage Search (OSS) Intermediate Representation.
import { z } from "zod";

export const Operator = z.enum([
  "eq", "neq", "lt", "lte", "gt", "gte",
  "in", "notIn",
  "contains", "startsWith", "endsWith",
  "exists", "missing",
  "between",
]);
export type Operator = z.infer<typeof Operator>;

export const Filter: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("term"),
      field: z.string().min(1),
      operator: Operator,
      value: z.unknown(),
    }),
    z.object({
      kind: z.literal("range"),
      field: z.string().min(1),
      gte: z.unknown().optional(),
      lte: z.unknown().optional(),
      gt: z.unknown().optional(),
      lt: z.unknown().optional(),
    }),
    z.object({ kind: z.literal("and"), filters: z.array(Filter).min(1) }),
    z.object({ kind: z.literal("or"), filters: z.array(Filter).min(1) }),
    z.object({ kind: z.literal("not"), filter: Filter }),
    z.object({
      kind: z.literal("geoDistance"),
      field: z.string().min(1),
      lat: z.number(),
      lon: z.number(),
      distanceMeters: z.number().positive(),
    }),
    z.object({
      kind: z.literal("knn"),
      field: z.string().min(1),
      vector: z.array(z.number()).min(1),
      k: z.number().int().positive(),
    }),
  ]),
);

export const SortOrder = z.object({
  field: z.string().min(1),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

export const SearchRequest = z.object({
  ontologyRid: z.string().min(1),
  objectType: z.string().min(1),
  branchRid: z.string().nullish(),
  filter: Filter.optional(),
  sort: z.array(SortOrder).optional(),
  pageSize: z.number().int().min(1).max(10000).default(50),
  cursor: z.string().optional(),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

export const AggregateRequest = z.object({
  ontologyRid: z.string().min(1),
  objectType: z.string().min(1),
  branchRid: z.string().nullish(),
  filter: Filter.optional(),
  aggregations: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("count"), name: z.string() }),
    z.object({ kind: z.literal("sum"), name: z.string(), field: z.string() }),
    z.object({ kind: z.literal("avg"), name: z.string(), field: z.string() }),
    z.object({ kind: z.literal("min"), name: z.string(), field: z.string() }),
    z.object({ kind: z.literal("max"), name: z.string(), field: z.string() }),
    z.object({ kind: z.literal("terms"), name: z.string(), field: z.string(), size: z.number().int().min(1).max(1000).default(10) }),
  ])).min(1),
});
export type AggregateRequest = z.infer<typeof AggregateRequest>;

export interface IrValidationError extends Error {
  code: 'INVALID_ARGUMENT';
  issues: unknown[];
}

export function parseSearchRequest(payload: unknown): SearchRequest {
  const r = SearchRequest.safeParse(payload);
  if (!r.success) {
    const e: IrValidationError = Object.assign(new Error("INVALID_ARGUMENT: search request failed schema validation"), {
      code: 'INVALID_ARGUMENT' as const,
      issues: r.error.issues,
    });
    throw e;
  }
  return r.data;
}

export function parseAggregateRequest(payload: unknown): AggregateRequest {
  const r = AggregateRequest.safeParse(payload);
  if (!r.success) {
    const e: IrValidationError = Object.assign(new Error("INVALID_ARGUMENT: aggregate request failed schema validation"), {
      code: 'INVALID_ARGUMENT' as const,
      issues: r.error.issues,
    });
    throw e;
  }
  return r.data;
}
