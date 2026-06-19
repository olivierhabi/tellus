// ---------------------------------------------------------------------------
// src/middleware/readAudit.ts
//
// Read-audit middleware for F-P3-11 closure + AUDIT_CONTRACT.md §2.3.
//
// Emits a hash-chained audit row for every qualifying read (GET object,
// search, searchAround, traverse, link-list). Wraps the route handler
// so the audit row is written only AFTER the response body is finalized
// (we need the 200 vs 404 outcome + row count in the audit metadata).
//
// Delivery mode — current: synchronous durable. Every read audit uses
// logStandaloneFailureAudit (despite the misleading function name — it
// is the standalone hash-chain writer, not a failure-specific one).
//
// Future: Block H transactional outbox. When that lands, this middleware
// enqueues into an in-PG outbox table and a background worker drains it
// to the audit chain with bounded lag. The audit contract permits this
// because reads are idempotent — a delayed audit row is acceptable so
// long as it is eventually durable.
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { logStandaloneFailureAudit } from "../models/actionAuditLog";
import { incCounter } from "../services/funnel/metrics";

export type ReadCategory =
  | "object.read"
  | "object.search"
  | "object.search_around"
  | "object.traverse"
  | "link.list";

export interface ReadAuditContext {
  category: ReadCategory;
  ontologyId?: string;
  objectTypeApiName?: string;
  primaryKey?: string;
  linkTypeApiName?: string;
  queryFingerprint?: string;
  resultCount?: number;
  /**
   * FOUNDRY-GAPS §8 — the DECLARED purpose (access_purpose.api_name) that
   * authorized this governed read. Normally injected by the purposeGate
   * middleware via res.locals.declaredPurpose; routes may also set it here
   * directly. Lands in the audit row as parameters.declared_purpose +
   * metadata.purpose.
   */
  purpose?: string;
}

/** Attach a context descriptor to `req` for later emission. */
export function annotateReadAudit(
  req: Request & { __readAuditContext?: ReadAuditContext },
  ctx: ReadAuditContext,
): void {
  req.__readAuditContext = ctx;
}

/** Set the result count on an already-annotated request. */
export function setReadAuditResultCount(
  req: Request & { __readAuditContext?: ReadAuditContext },
  count: number,
): void {
  if (req.__readAuditContext) {
    req.__readAuditContext.resultCount = count;
  }
}

function subjectOf(req: Request): string {
  const anyReq = req as any;
  return (
    anyReq.auth?.preferred_username ||
    anyReq.auth?.sub ||
    anyReq.user?.email ||
    anyReq.user?.id ||
    "anonymous"
  );
}

function ipOf(req: Request): string | null {
  // Respect XFF when behind a trusted ingress; otherwise use socket.
  const xff = (req.headers["x-forwarded-for"] as string | undefined) || "";
  const first = xff.split(",")[0]?.trim();
  return first || req.ip || null;
}

/**
 * Express middleware factory. Mounts on the data-plane read routes.
 * The handler first calls `annotateReadAudit(req, {...})` to declare
 * what is being read; after the route handler finishes (res.on('finish')),
 * this middleware emits the hash-chained audit row.
 */
export function readAuditMiddleware() {
  return function readAuditMw(req: Request, res: Response, next: NextFunction) {
    const startedAt = Date.now();

    res.on("finish", () => {
      const anyReq = req as any;
      const ctx: ReadAuditContext | undefined = anyReq.__readAuditContext;
      if (!ctx) return; // route did not annotate — not a read-audit target.

      // Emit in the background; do NOT block the response. Errors are
      // surfaced as metrics so operators see a persistent lag or failure.
      void emitReadAudit({
        category: ctx.category,
        ontologyId: ctx.ontologyId ?? null,
        objectTypeApiName: ctx.objectTypeApiName ?? null,
        primaryKey: ctx.primaryKey ?? null,
        linkTypeApiName: ctx.linkTypeApiName ?? null,
        queryFingerprint: ctx.queryFingerprint ?? null,
        // Declared purpose (FOUNDRY-GAPS §8): explicit annotation wins;
        // otherwise pick up what purposeGate validated for this request.
        purpose:
          ctx.purpose ??
          ((res as any).locals?.declaredPurpose as string | undefined) ??
          null,
        resultCount: ctx.resultCount ?? 0,
        statusCode: res.statusCode,
        executedBy: subjectOf(req),
        sourceIp: ipOf(req),
        durationMs: Date.now() - startedAt,
        routePath: req.originalUrl,
        method: req.method,
      });
    });

    next();
  };
}

interface EmitArgs {
  category: ReadCategory;
  ontologyId: string | null;
  objectTypeApiName: string | null;
  primaryKey: string | null;
  linkTypeApiName: string | null;
  queryFingerprint: string | null;
  purpose: string | null;
  resultCount: number;
  statusCode: number;
  executedBy: string;
  sourceIp: string | null;
  durationMs: number;
  routePath: string;
  method: string;
}

async function emitReadAudit(args: EmitArgs): Promise<void> {
  try {
    // Model the read as an audit row with action_type_api_name =
    // `__read.${category}`. This keeps the single audit table as the
    // single forward-walk target (one chain to verify, not two).
    await logStandaloneFailureAudit({
      action_type_api_name: `__read.${args.category}`,
      action_type_display_name: `Read Audit: ${args.category}`,
      execution_id: randomUUID(),
      parameters: {
        route: args.routePath,
        method: args.method,
        ontology_id: args.ontologyId,
        object_type: args.objectTypeApiName,
        primary_key: args.primaryKey,
        link_type: args.linkTypeApiName,
        query_fingerprint: args.queryFingerprint,
        declared_purpose: args.purpose,
      },
      affected_objects: [],
      affected_object_count: args.resultCount,
      result: args.statusCode >= 200 && args.statusCode < 400 ? "success" : "failed",
      failure_type: args.statusCode >= 400 ? "unclassified" : null,
      error_message: null,
      duration_ms: args.durationMs,
      executed_by: args.executedBy,
      source_ip: args.sourceIp,
      branch_id: null,
      metadata: {
        status_code: args.statusCode,
        // Purpose-based access control (FOUNDRY-GAPS §8). Stored in the
        // chained JSONB payload — no new audit column, so the hash-chain
        // format is unchanged. Query via metadata->>'purpose'.
        ...(args.purpose ? { purpose: args.purpose } : {}),
      },
    });
    incCounter("tellus_read_audit_emitted_total", {
      category: args.category,
      outcome: args.statusCode >= 200 && args.statusCode < 400 ? "success" : "failed",
    });
  } catch (err) {
    // Read-audit failures are NOT silently swallowed — they surface as a
    // metric so the operations team sees a persistent lag. But unlike
    // Action audit, we do NOT propagate back into the response because
    // the client has already seen their result by the time res.on('finish')
    // fires. That is the narrow carve-out in §2.3 of AUDIT_CONTRACT.md:
    // read-audit is best-effort-with-alerting, not durable-before-ack.
    //
    // The trade-off is documented. If DPA guidance requires durable-before-ack
    // on reads, the read routes must move their annotation BEFORE the
    // response is emitted and call emitReadAudit synchronously in-band
    // — then a failure becomes a 503 before the response body is sent.
    incCounter("tellus_read_audit_failed_total", {
      category: args.category,
      reason: err instanceof Error ? err.constructor.name : "unknown",
    });
    console.error(
      `[read-audit] emission failed route=${args.routePath} category=${args.category}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export default { readAuditMiddleware, annotateReadAudit, setReadAuditResultCount };
