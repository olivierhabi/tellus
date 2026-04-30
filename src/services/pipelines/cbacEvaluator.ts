// ---------------------------------------------------------------------------
// CBAC predicate evaluator — PB-B7 follow-cbac.
//
// Intentionally minimal grammar. A predicate is a JSON object with one
// of these shapes:
//
//   {"op":"and","args":[<predicate>, ...]}
//   {"op":"or", "args":[<predicate>, ...]}
//   {"op":"not","args":[<predicate>]}
//   {"op":"eq","left":<expr>,"right":<expr>}
//   {"op":"neq","left":<expr>,"right":<expr>}
//   {"op":"in","value":<expr>,"set":<expr[]>}
//   {"op":"has","value":<expr[]>,"member":<expr>}
//
// <expr> is a literal (string | number | boolean | array) OR a context
// path: `{"var":"user.email"}` / `{"var":"user.groups"}` /
// `{"var":"project.name"}` / `{"var":"pipeline.name"}`.
//
// Why not import a full JSONLogic library? The grammar above is enough
// for the admission cases we actually enforce (deny-by-region,
// allow-if-in-group, deny-outside-window). A library adds dependency
// surface + an unbounded set of operators we'd then have to review for
// safety (`substr`, `reduce`, recursion).
// ---------------------------------------------------------------------------

import type { Knex } from "knex";
import foundryDb from "../../config/foundryDb";
import { AppError } from "../../utils/foundryAppError";

export interface CbacContext {
  user: {
    id: string;
    email?: string | null;
    groups?: string[];
  };
  pipeline: {
    id: string;
    name?: string | null;
    projectId: string;
  };
  project: {
    id: string;
    name?: string | null;
    ownerId?: string | null;
  };
  /** Timestamp in unix seconds at evaluation (injected — deterministic in tests). */
  nowSec: number;
}

export type CbacPredicate =
  | CbacAnd
  | CbacOr
  | CbacNot
  | CbacEq
  | CbacNeq
  | CbacIn
  | CbacHas;

export interface CbacAnd { op: "and"; args: CbacPredicate[] }
export interface CbacOr  { op: "or";  args: CbacPredicate[] }
export interface CbacNot { op: "not"; args: [CbacPredicate] }
export interface CbacEq  { op: "eq";  left: CbacExpr; right: CbacExpr }
export interface CbacNeq { op: "neq"; left: CbacExpr; right: CbacExpr }
export interface CbacIn  { op: "in";  value: CbacExpr; set: CbacExpr }
export interface CbacHas { op: "has"; value: CbacExpr; member: CbacExpr }

export type CbacExpr =
  | CbacVar
  | string | number | boolean | null
  | Array<string | number | boolean | null>;
export interface CbacVar { var: string }

/**
 * Evaluate a predicate against a context. Returns a strict boolean —
 * an `and` with zero args is `true` (vacuously), an `or` with zero
 * args is `false`. Unknown operator → throws CBAC_PREDICATE_INVALID.
 */
export function evaluate(pred: unknown, ctx: CbacContext): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = pred as any;
  switch (p?.op) {
    case "and":
      return ((p.args as CbacPredicate[]) ?? []).every((a) => evaluate(a, ctx));
    case "or":
      return ((p.args as CbacPredicate[]) ?? []).some((a) => evaluate(a, ctx));
    case "not":
      return !evaluate((p.args as CbacPredicate[])[0], ctx);
    case "eq":
      return equal(resolve(p.left as CbacExpr, ctx), resolve(p.right as CbacExpr, ctx));
    case "neq":
      return !equal(resolve(p.left as CbacExpr, ctx), resolve(p.right as CbacExpr, ctx));
    case "in": {
      const v = resolve(p.value as CbacExpr, ctx);
      const s = resolve(p.set as CbacExpr, ctx);
      if (!Array.isArray(s)) return false;
      return s.some((x) => equal(x, v));
    }
    case "has": {
      const v = resolve(p.value as CbacExpr, ctx);
      const m = resolve(p.member as CbacExpr, ctx);
      if (!Array.isArray(v)) return false;
      return v.some((x) => equal(x, m));
    }
    default:
      throw new AppError(
        `Unknown CBAC operator: ${String(p?.op)}`,
        400,
        "CBAC_PREDICATE_INVALID",
      );
  }
}

function resolve(expr: CbacExpr, ctx: CbacContext): unknown {
  if (expr === null) return null;
  if (typeof expr === "string" || typeof expr === "number" || typeof expr === "boolean") {
    return expr;
  }
  if (Array.isArray(expr)) return expr.map((e) => resolve(e, ctx));
  if (
    typeof expr === "object" &&
    expr !== null &&
    "var" in (expr as unknown as Record<string, unknown>)
  ) {
    const path = String((expr as CbacVar).var).split(".");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cursor: any = ctx;
    for (const seg of path) {
      if (cursor == null) return null;
      cursor = cursor[seg];
    }
    return cursor ?? null;
  }
  return null;
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof b === "number" && typeof a === "string") return String(b) === a;
  return false;
}

/**
 * Admission entry point — runs every enabled rule for `pipelineId`
 * against the (user, pipeline, project) context. Throws
 * `CBAC_RULE_VIOLATION` on first false rule with the offending rule id
 * so operators can diff the denial log against the rule list.
 */
export async function assertCbacAdmission(
  pipelineId: string,
  ctx: CbacContext,
  knex: Knex = foundryDb,
): Promise<void> {
  const rules: Array<{ rule_id: string; description: string | null; predicate: unknown }> =
    await knex("pipeline_cbac_rule")
      .where({ pipeline_id: pipelineId, enabled: true })
      .select("rule_id", "description", "predicate");
  if (rules.length === 0) return;
  for (const r of rules) {
    let ok: boolean;
    try {
      ok = evaluate(r.predicate, ctx);
    } catch (err) {
      // Invalid predicate → fail-closed (reject) so a typo in one rule
      // doesn't silently admit traffic.
      const err2 = new AppError(
        `CBAC rule ${r.rule_id} is invalid: ${(err as Error).message}`,
        500,
        "CBAC_PREDICATE_INVALID",
      );
      (err2 as unknown as { details?: unknown }).details = { ruleId: r.rule_id };
      throw err2;
    }
    if (!ok) {
      const err = new AppError(
        `Deploy rejected by CBAC rule ${r.rule_id}${r.description ? ` (${r.description})` : ""}.`,
        403,
        "CBAC_RULE_VIOLATION",
      );
      (err as unknown as { details?: unknown }).details = {
        ruleId: r.rule_id,
        description: r.description ?? null,
      };
      throw err;
    }
  }
}
