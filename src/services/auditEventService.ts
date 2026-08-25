/**
 * auditEventService.ts
 * --------------------
 * Tellus-side audit log. Complements Keycloak's native events API
 * (which only captures LOGIN / LOGOUT / TOKEN events) with the
 * credential-management surface that lives entirely inside tellus:
 * password changes, TOTP enrollment, WebAuthn credential lifecycle,
 * PAT create/revoke, reauth challenges, etc.
 *
 * Every row is append-only (the DDL in migrateAuth.ts doesn't grant
 * UPDATE / DELETE) and keyed on the Keycloak `sub`. The `/me/audit`
 * endpoint merges these rows with the Keycloak event stream so the
 * settings UI surfaces one unified history.
 *
 * F-07: Audit writes are now **durable before ack**. The emitAuditEvent
 * function throws on failure so callers abort the operation rather than
 * returning a success response with a silently dropped audit row. This
 * is non-negotiable under Rwandan tax law (Data Protection Law
 * No. 058/2021) and the EAC Data Protection Framework.
 *
 * F-08: Extended audit categories cover object reads, writes, link
 * traversals, and search queries — not just auth lifecycle events.
 *
 * F-15: Prometheus counter `tellus_audit_emit_failures_total` is
 * incremented on every write failure for alerting.
 */

import type { Request } from 'express';
import type { Knex } from 'knex';
import foundryDb from '../config/foundryDb';

export type AuditCategory =
  | 'password'
  | 'totp'
  | 'webauthn'
  | 'pat'
  | 'session'
  | 'reauth'
  | 'mfa'
  | 'admin'
  // PB-B7 — per-pipeline ACL changes + marking-policy deny events.
  | 'pipeline_acl'
  | 'pipeline_marking'
  // F-08: Data-plane audit categories for regulatory compliance.
  | 'object'
  | 'link'
  | 'search'
  | 'action';

export type AuditAction =
  // password
  | 'password.change'
  // totp
  | 'totp.enroll.start'
  | 'totp.enroll.verify'
  | 'totp.disable'
  // webauthn
  | 'webauthn.register'
  | 'webauthn.delete'
  | 'webauthn.authenticate'
  // pat
  | 'pat.create'
  | 'pat.revoke'
  // session
  | 'session.login'
  | 'session.logout'
  | 'session.logout-all'
  | 'session.revoke'
  | 'session.passkey-enrollment-required'
  // mfa gates
  | 'mfa.login'
  | 'mfa.budget-exceeded'
  // reauth
  | 'reauth.issue'
  | 'reauth.fail'
  // superadmin console
  | 'admin.user.create'
  | 'admin.user.invite'
  | 'admin.user.delete'
  | 'admin.user.enable'
  | 'admin.user.disable'
  | 'admin.setting.update'
  | 'admin.role.create'
  | 'admin.role.update'
  | 'admin.role.delete'
  | 'admin.role.member.add'
  | 'admin.role.member.remove'
  // PB-B7
  | 'pipeline.acl.grant'
  | 'pipeline.acl.revoke'
  | 'pipeline.acl.deny'
  | 'pipeline.marking.deny'
  | 'pipeline.marking.propagate'
  // F-08: Data-plane audit actions
  | 'object.read'
  | 'object.create'
  | 'object.update'
  | 'object.delete'
  | 'object.search'
  | 'link.traverse'
  | 'link.create'
  | 'link.delete'
  | 'search.execute'
  | 'action.execute'
  | 'action.validate'
  // P0 build/materialize-path dataset access (deny + check-error outcomes).
  | 'transform.dataset.read'
  | 'transform.dataset.write';

export interface EmitAuditOpts {
  keycloakSub: string;
  category: AuditCategory;
  action: AuditAction;
  result: 'SUCCESS' | 'FAILURE';
  req?: Request;
  details?: Record<string, unknown>;
}

function extractIp(req?: Request): string | null {
  if (!req) return null;
  // req.ip respects the Express `trust proxy` setting — when we're
  // behind a load balancer, express rewrites req.ip to the true client.
  return (req.ip || (req.socket && req.socket.remoteAddress)) ?? null;
}

function extractUserAgent(req?: Request): string | null {
  const ua = req?.headers['user-agent'];
  if (!ua) return null;
  // Cap at 512 chars so a pathological UA can't bloat the row.
  return Array.isArray(ua) ? ua[0]?.slice(0, 512) ?? null : ua.slice(0, 512);
}

// F-15: Prometheus counter for audit write failures.
let auditFailureCounter: { inc: () => void } | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const prom = require('prom-client');
  auditFailureCounter = new prom.Counter({
    name: 'tellus_audit_emit_failures_total',
    help: 'Total number of audit event write failures',
  });
} catch {
  // prom-client not available — counter is a no-op
}

/**
 * F-07: Audit writes are durable before ack. This function **throws**
 * on failure so that the calling operation aborts rather than returning
 * success with a silently dropped audit row.
 *
 * For auth-lifecycle events (where blocking the login flow on an audit
 * failure would lock users out), use `emitAuditEventBestEffort` instead.
 */
export async function emitAuditEvent(opts: EmitAuditOpts): Promise<void> {
  try {
    await (foundryDb as unknown as Knex)('tellus_audit_events').insert({
      keycloak_sub: opts.keycloakSub,
      category: opts.category,
      action: opts.action,
      result: opts.result,
      ip: extractIp(opts.req),
      user_agent: extractUserAgent(opts.req),
      details: opts.details ? JSON.stringify(opts.details) : '{}',
    });
  } catch (err) {
    auditFailureCounter?.inc();
    console.error(
      JSON.stringify({
        type: 'audit_emit_failed',
        timestamp: new Date().toISOString(),
        action: opts.action,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    // F-07: Re-throw so the caller aborts. Audit durability is
    // non-negotiable under Rwandan Data Protection Law No. 058/2021.
    throw new Error(
      `Audit write failed for action '${opts.action}': ${
        err instanceof Error ? err.message : String(err)
      }. Operation aborted to preserve audit trail integrity.`
    );
  }
}

/**
 * Best-effort audit emit for auth-lifecycle events where blocking
 * the user operation on audit failure would cause lockout. Logs
 * and increments the Prometheus counter but does NOT throw.
 */
export async function emitAuditEventBestEffort(opts: EmitAuditOpts): Promise<void> {
  try {
    await (foundryDb as unknown as Knex)('tellus_audit_events').insert({
      keycloak_sub: opts.keycloakSub,
      category: opts.category,
      action: opts.action,
      result: opts.result,
      ip: extractIp(opts.req),
      user_agent: extractUserAgent(opts.req),
      details: opts.details ? JSON.stringify(opts.details) : '{}',
    });
  } catch (err) {
    auditFailureCounter?.inc();
    console.error(
      JSON.stringify({
        type: 'audit_emit_failed_best_effort',
        timestamp: new Date().toISOString(),
        action: opts.action,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export interface AuditQuery {
  keycloakSub: string;
  category?: AuditCategory;
  since?: Date;
  limit?: number;
}

export interface AuditRow {
  id: string;
  category: AuditCategory;
  action: AuditAction;
  result: 'SUCCESS' | 'FAILURE';
  ip: string | null;
  userAgent: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export async function listAuditEvents(q: AuditQuery): Promise<AuditRow[]> {
  const knex = foundryDb as unknown as Knex;
  let query = knex('tellus_audit_events')
    .where({ keycloak_sub: q.keycloakSub })
    .orderBy('created_at', 'desc')
    .limit(Math.min(q.limit ?? 100, 500));
  if (q.category) query = query.andWhere({ category: q.category });
  if (q.since) query = query.andWhere('created_at', '>=', q.since);
  const rows = await query;
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    action: r.action,
    result: r.result,
    ip: r.ip,
    userAgent: r.user_agent,
    details:
      typeof r.details === 'string'
        ? (() => {
            try {
              return JSON.parse(r.details);
            } catch {
              return {};
            }
          })()
        : r.details ?? {},
    createdAt:
      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  }));
}
