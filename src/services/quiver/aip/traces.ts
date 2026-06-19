// Quiver B9 — Reasoning-trace persistence (B9 C-09/C-10).

import { createHash } from "crypto";
import { query } from "../../../db.js";
import { newQuiverRid } from "../rids.js";
import type { AipSurface, ToolInvocation } from "./types.js";

export interface TraceRow {
  readonly rid: string;
  readonly analysisRid: string;
  readonly userRid: string;
  readonly surface: AipSurface;
  readonly promptSha256: string;
  readonly prompt: string;
  readonly traceBlobUri: string | null;
  readonly toolInvocations: ReadonlyArray<ToolInvocation>;
  readonly totalTokens: number | null;
  readonly costUsdMicros: number | null;
  readonly createdAt: string;
}

export function newTraceRid(): string {
  return newQuiverRid("trace");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface PersistTraceInput {
  readonly rid: string;
  readonly analysisRid: string;
  readonly userRid: string;
  readonly surface: AipSurface;
  readonly prompt: string;
  readonly toolInvocations: ReadonlyArray<ToolInvocation>;
  readonly totalTokens?: number;
  readonly costUsdMicros?: number;
  readonly traceBlobUri?: string;
}

export async function persistTrace(input: PersistTraceInput): Promise<void> {
  await query(
    `INSERT INTO quiver_aip_trace
       (rid, analysis_rid, user_rid, surface, prompt_sha256, prompt,
        trace_blob_uri, tool_invocations, total_tokens, cost_usd_micros)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    [
      input.rid,
      input.analysisRid,
      input.userRid,
      input.surface,
      sha256(input.prompt),
      input.prompt,
      input.traceBlobUri ?? null,
      JSON.stringify(input.toolInvocations),
      input.totalTokens ?? null,
      input.costUsdMicros ?? null,
    ],
  );
}

interface TraceRowDb {
  rid: string;
  analysis_rid: string;
  user_rid: string;
  surface: AipSurface;
  prompt_sha256: string;
  prompt: string;
  trace_blob_uri: string | null;
  tool_invocations: ReadonlyArray<ToolInvocation>;
  total_tokens: number | null;
  cost_usd_micros: number | null;
  created_at: Date | string;
}

export async function getTrace(traceRid: string): Promise<TraceRow | null> {
  const r = await query(`SELECT * FROM quiver_aip_trace WHERE rid = $1`, [
    traceRid,
  ]);
  const row = r.rows[0] as TraceRowDb | undefined;
  if (!row) return null;
  return {
    rid: row.rid,
    analysisRid: row.analysis_rid,
    userRid: row.user_rid,
    surface: row.surface,
    promptSha256: row.prompt_sha256,
    prompt: row.prompt,
    traceBlobUri: row.trace_blob_uri,
    toolInvocations: row.tool_invocations,
    totalTokens: row.total_tokens,
    costUsdMicros: row.cost_usd_micros,
    createdAt:
      typeof row.created_at === "string"
        ? row.created_at
        : row.created_at.toISOString(),
  };
}
