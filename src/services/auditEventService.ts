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
 * The emit() helper is intentionally fire-and-forget: a failure to
 * write an audit row must never block the user-visible operation.
 * We log the error to stderr and move on.
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
  | 'pipeline_marking';

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
  | 'admin.user.delete'
  | 'admin.user.enable'
  | 'admin.user.disable'
  | 'admin.setting.update'
  // PB-B7
  | 'pipeline.acl.grant'
  | 'pipeline.acl.revoke'
  | 'pipeline.acl.deny'
  | 'pipeline.marking.deny'
  | 'pipeline.marking.propagate';

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
    // Audit must never block the caller — log and swallow.
    console.error(
      JSON.stringify({
        type: 'audit_emit_failed',
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
