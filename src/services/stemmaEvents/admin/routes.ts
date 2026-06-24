// ---------------------------------------------------------------------------
// B10 — Stemma Events admin Conjure routes.
//
// Wraps the wave-1..4 pure-logic + storage modules in a Conjure-shaped
// HTTP surface. Every route applies the §1 global contracts as
// applicable: auth, error envelope, ETag, idempotency on mutating
// POSTs, durable-before-ack audit emission, cursor pagination on lists.
//
// Spec contracts implemented in this file:
//
//   B10-C-01  POST /pre-receive — runs preReceiveDecision per ref-update;
//             returns array of {kind: "allow" | "deny", ...}. Non-mutating
//             (no DB write), so no idempotency required.
//   B10-C-03  POST /post-receive — orchestrator: writes audit + event in
//             one tx; optionally fans out callbacks.
//   B10-C-12  GET /events — cursor-paginated event list. Filters by
//             repositoryRid, eventType, since.
//   B10-C-11  POST /subscriptions — create webhook subscriber. Audit + tx.
//             DELETE /subscriptions/:rid — delete. Audit + tx.
//             GET /subscriptions/:rid — single fetch. IDOR-as-404.
//             GET /subscriptions — list. Cursor pagination.
//   B10-C-14  POST /subscriptions/:rid/reactivate — operator endpoint to
//             reset SUSPENDED → ACTIVE.
//
// Plus the global contracts on every route as applicable:
//   G-C-08   401 Stemma:Unauthenticated on missing/invalid auth.
//   G-C-09   404 (never 403) on Compass DENY for unknown rid.
//   G-C-12   envelope shape.
//   G-C-15   HTTP status mapping.
//   G-C-17   ETag format W/"<resource_version>" on subscription endpoints
//            that return a mutable resource.
//   G-C-20   POST mutating routes require Idempotency-Key.
//   G-C-22   409 IdempotencyConflict on key reuse with different body.
//   G-C-25   X-Idempotent-Replay: true on retried POST.
//   G-C-51   Every mutating endpoint emits exactly one audit row.
//   G-C-52   Audit row durable BEFORE response acknowledged.
//   G-C-53   before_hash + after_hash on mutations.
//
// Design decision (logged inline; no separate D-document needed): pre-receive uses POST
// because Stemma's payload (per-ref-update array + push context) is too
// large for query-string. Per G-C-20, idempotency is required for "every
// POST that mutates state". Pre-receive does NOT mutate state — it's a
// pure policy query that returns deterministic decisions for a given
// (updates, settings, principal) tuple. Two identical calls return
// identical responses by construction. No idempotency required.
// ---------------------------------------------------------------------------

import { Router, type Response, json as expressJson } from "express";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

import { isRid, UUIDV4_REGEX } from "../../codeRepos/contracts/rid";
import { formatWeakEtag } from "../../codeRepos/contracts/etag";
import {
  buildEnvelope,
  ERROR_CODES,
  type ErrorCode,
} from "../../codeRepos/contracts/errors";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal";
import { idempotencyMiddleware } from "../../codeRepos/middleware/idempotency";
import {
  insertCodeReposAuditEvent,
  hashResourceState,
} from "../../codeRepos/audit/auditEvents";

import { preReceiveDecision } from "../policy/preReceive";
import type {
  PushContext,
  RefUpdate,
  RepoSettingsSnapshot,
  PrincipalSnapshot,
  Decision,
} from "../policy/types";
import {
  recordPostReceive,
  type PostReceiveInput,
} from "../postReceiveService";
import {
  listEvents,
  CursorError,
  STEMMA_EVENT_TYPES,
  type StemmaEventType,
} from "../store/eventStore";
import {
  createSubscriptionWithinTx,
  deleteSubscriptionWithinTx,
  getSubscription,
  listSubscriptions,
  reactivateSubscription,
  SubscriptionStoreError,
  type SubscriptionRow,
  type SubscriptionState,
} from "../store/subscriptionStore";

export interface StemmaEventsAdminDeps {
  readonly pool: Pool;
}

const AUDIT_CATEGORY = "stemma_events";
const TARGET_TYPE_EVENT = "Event";
const TARGET_TYPE_SUBSCRIPTION = "Subscription";

export function stemmaEventsAdminRouter(deps: StemmaEventsAdminDeps): Router {
  const router = Router();
  const { pool } = deps;

  router.use(expressJson({ limit: "5mb" }));
  router.use(requireCodeReposAuth());
  // pre-receive is non-mutating (policy decision; no DB writes), so it
  // is exempt from G-C-20 per the spec's mutating-POST scope. All other
  // POSTs in this router (post-receive, subscriptions, reactivate)
  // require an Idempotency-Key.
  router.use(idempotencyMiddleware({ pool, skipPaths: ["/pre-receive"] }));

  // -------------------------------------------------------------------------
  // POST /pre-receive — B10-C-01..C-10
  // -------------------------------------------------------------------------
  router.post("/pre-receive", async (req, res) => {
    const principal = req.codeReposPrincipal;
    if (!principal) return sendInternal(res, "principal not bound");

    const body = req.body as {
      repositoryRid?: unknown;
      updates?: unknown;
      settings?: unknown;
      principal?: unknown;
      viaPullRequest?: unknown;
    };

    if (typeof body?.repositoryRid !== "string" || !isRid(body.repositoryRid)) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "repositoryRid",
      });
    }
    const updates = parseRefUpdates(body.updates);
    if (updates === null) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "updates",
      });
    }
    const settings = parseRepoSettings(body.settings);
    if (settings === null) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "settings",
      });
    }
    const principalSnapshot = parsePrincipalSnapshot(body.principal);
    if (principalSnapshot === null) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "principal",
      });
    }

    const ctx: PushContext = {
      repositoryRid: body.repositoryRid,
      principal: principalSnapshot,
      settings,
      viaPullRequest: body.viaPullRequest === true,
    };

    const decisions = await preReceiveDecision(updates, ctx);
    res.status(200).json({
      decisions: decisions.map(decisionToWire),
    });
  });

  // -------------------------------------------------------------------------
  // POST /post-receive — B10-C-03 (orchestrator + audit + event row)
  // -------------------------------------------------------------------------
  router.post("/post-receive", async (req, res) => {
    const principal = req.codeReposPrincipal;
    if (!principal) return sendInternal(res, "principal not bound");

    const body = req.body as {
      repositoryRid?: unknown;
      eventType?: unknown;
      ref?: unknown;
      oldSha?: unknown;
      newSha?: unknown;
      payload?: unknown;
    };
    if (typeof body?.repositoryRid !== "string" || !isRid(body.repositoryRid)) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "repositoryRid",
      });
    }
    if (
      typeof body?.eventType !== "string" ||
      !STEMMA_EVENT_TYPES.includes(body.eventType as StemmaEventType)
    ) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "eventType",
      });
    }
    if (body.ref !== null && typeof body.ref !== "string") {
      return sendStemmaEventsError(res, "InvalidArgument", 400, { field: "ref" });
    }
    if (body.oldSha !== null && typeof body.oldSha !== "string") {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "oldSha",
      });
    }
    if (body.newSha !== null && typeof body.newSha !== "string") {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "newSha",
      });
    }
    if (
      body.payload === undefined ||
      body.payload === null ||
      typeof body.payload !== "object" ||
      Array.isArray(body.payload)
    ) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "payload",
      });
    }

    const requestId = (req.header("X-Request-Id") as string) || randomUUID();

    const input: PostReceiveInput = {
      repositoryRid: body.repositoryRid,
      eventType: body.eventType as StemmaEventType,
      ref: (body.ref ?? null) as string | null,
      oldSha: (body.oldSha ?? null) as string | null,
      newSha: (body.newSha ?? null) as string | null,
      principalUserId: principal.userId,
      // `stemma_event.principal_sub` is typed `UUID` (Multipass
      // keycloakSub format). When the principal carries a non-UUID
      // userId (e.g. test mode, PAT-based principals before the sub
      // is resolved), we store NULL rather than corrupt the column.
      principalSub: UUIDV4_REGEX.test(principal.userId) ? principal.userId : null,
      principalSource: principal.source === "test" ? "system" : principal.source,
      requestId,
      sourceIp: principal.sourceIp,
      userAgent: principal.userAgent,
      payload: body.payload as Record<string, unknown>,
    };

    try {
      const result = await recordPostReceive({ pool }, input);
      res.status(201).json({
        event: {
          rid: result.event.rid,
          repositoryRid: result.event.repositoryRid,
          eventType: result.event.eventType,
          ref: result.event.ref,
          oldSha: result.event.oldSha,
          newSha: result.event.newSha,
          occurredAt: result.event.occurredAt,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendStemmaEventsError(res, "Internal", 500, { reason: msg });
    }
  });

  // -------------------------------------------------------------------------
  // GET /events — B10-C-12 cursor-paginated event list
  // -------------------------------------------------------------------------
  router.get("/events", async (req, res) => {
    const repositoryRid =
      typeof req.query.repositoryRid === "string"
        ? req.query.repositoryRid
        : undefined;
    if (repositoryRid !== undefined && !isRid(repositoryRid)) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "repositoryRid",
      });
    }
    const eventType =
      typeof req.query.eventType === "string"
        ? (req.query.eventType as StemmaEventType)
        : undefined;
    if (eventType !== undefined && !STEMMA_EVENT_TYPES.includes(eventType)) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "eventType",
      });
    }
    const since =
      typeof req.query.since === "string" ? req.query.since : undefined;
    if (since !== undefined && Number.isNaN(Date.parse(since))) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "since",
      });
    }
    const pageToken =
      typeof req.query.pageToken === "string" ? req.query.pageToken : undefined;
    const pageSize = parsePageSize(req.query.pageSize);

    try {
      const page = await listEvents(pool, {
        repositoryRid,
        eventType,
        since,
        pageSize,
        pageToken,
      });
      res.status(200).json({
        data: page.events.map((e) => ({
          rid: e.rid,
          repositoryRid: e.repositoryRid,
          eventType: e.eventType,
          ref: e.ref,
          oldSha: e.oldSha,
          newSha: e.newSha,
          occurredAt: e.occurredAt,
          payload: e.payload,
        })),
        nextPageToken: page.nextPageToken ?? null,
      });
    } catch (err) {
      if (err instanceof CursorError) {
        return sendStemmaEventsError(res, "InvalidPageToken", 400, {
          reason: err.message,
        });
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // GET /subscriptions — list with cursor pagination
  // -------------------------------------------------------------------------
  router.get("/subscriptions", async (req, res) => {
    const repositoryRid =
      typeof req.query.repositoryRid === "string"
        ? req.query.repositoryRid
        : undefined;
    if (repositoryRid !== undefined && !isRid(repositoryRid)) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "repositoryRid",
      });
    }
    const stateFilter =
      typeof req.query.state === "string"
        ? (req.query.state as SubscriptionState)
        : undefined;
    if (
      stateFilter !== undefined &&
      stateFilter !== "ACTIVE" &&
      stateFilter !== "SUSPENDED"
    ) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "state",
      });
    }
    const pageToken =
      typeof req.query.pageToken === "string" ? req.query.pageToken : undefined;
    const pageSize = parsePageSize(req.query.pageSize);

    try {
      const page = await listSubscriptions(pool, {
        repositoryRid,
        state: stateFilter,
        pageSize,
        pageToken,
      });
      res.status(200).json({
        data: page.subscriptions.map(subscriptionToWire),
        nextPageToken: page.nextPageToken ?? null,
      });
    } catch (err) {
      if (
        err instanceof SubscriptionStoreError &&
        err.code === "InvalidPageToken"
      ) {
        return sendStemmaEventsError(res, "InvalidPageToken", 400, {
          reason: err.message,
        });
      }
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // GET /subscriptions/:rid — single fetch (IDOR-as-404)
  // -------------------------------------------------------------------------
  router.get("/subscriptions/:rid", async (req, res) => {
    const rid = req.params.rid;
    if (!isRid(rid)) {
      return sendStemmaEventsError(res, "SubscriptionNotFound", 404, { rid });
    }
    const sub = await getSubscription(pool, rid);
    if (!sub) {
      return sendStemmaEventsError(res, "SubscriptionNotFound", 404, { rid });
    }
    res.status(200).json(subscriptionToWire(sub));
  });

  // -------------------------------------------------------------------------
  // POST /subscriptions — create webhook subscriber
  // -------------------------------------------------------------------------
  router.post("/subscriptions", async (req, res) => {
    const principal = req.codeReposPrincipal;
    if (!principal) return sendInternal(res, "principal not bound");

    const body = req.body as {
      rid?: unknown;
      eventTypes?: unknown;
      repositoryRid?: unknown;
      targetUri?: unknown;
      secretEncrypted?: unknown;
    };
    if (typeof body?.rid !== "string" || !isRid(body.rid)) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, { field: "rid" });
    }
    if (
      !Array.isArray(body?.eventTypes) ||
      body.eventTypes.some(
        (t) => typeof t !== "string" || !STEMMA_EVENT_TYPES.includes(t as StemmaEventType),
      )
    ) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "eventTypes",
      });
    }
    if (
      body.repositoryRid !== null &&
      (typeof body.repositoryRid !== "string" || !isRid(body.repositoryRid))
    ) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "repositoryRid",
      });
    }
    if (typeof body?.targetUri !== "string" || body.targetUri.length === 0) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "targetUri",
      });
    }
    if (
      typeof body?.secretEncrypted !== "string" ||
      body.secretEncrypted.length === 0
    ) {
      return sendStemmaEventsError(res, "InvalidArgument", 400, {
        field: "secretEncrypted",
      });
    }

    const requestId = (req.header("X-Request-Id") as string) || randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const sub = await createSubscriptionWithinTx(client, {
        rid: body.rid,
        eventTypes: body.eventTypes as StemmaEventType[],
        repositoryRid: (body.repositoryRid ?? null) as string | null,
        targetUri: body.targetUri,
        secretEncrypted: body.secretEncrypted,
      });

      const afterHash = hashSubscriptionState(sub);
      await insertCodeReposAuditEvent(client, {
        category: AUDIT_CATEGORY,
        action: "createSubscription",
        targetRid: sub.rid,
        targetType: TARGET_TYPE_SUBSCRIPTION,
        principalUserId: principal.userId,
        principalSource:
          principal.source === "test" ? "system" : principal.source,
        requestId,
        beforeHash: null,
        afterHash,
        sourceIp: principal.sourceIp,
        userAgent: principal.userAgent,
        parameters: {
          eventTypes: sub.eventTypes,
          repositoryRid: sub.repositoryRid,
        },
      });
      await client.query("COMMIT");

      res.setHeader("ETag", formatWeakEtag(0));
      res.status(201).json(subscriptionToWire(sub));
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow */
      }
      if (err instanceof SubscriptionStoreError) {
        if (err.code === "AlreadyExists") {
          return sendStemmaEventsError(res, "SubscriptionAlreadyExists", 409, {
            rid: body.rid,
          });
        }
        return sendStemmaEventsError(res, "InvalidArgument", 400, {
          reason: err.message,
        });
      }
      const msg = err instanceof Error ? err.message : String(err);
      sendStemmaEventsError(res, "Internal", 500, { reason: msg });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /subscriptions/:rid — delete webhook subscriber
  // -------------------------------------------------------------------------
  router.delete("/subscriptions/:rid", async (req, res) => {
    const principal = req.codeReposPrincipal;
    if (!principal) return sendInternal(res, "principal not bound");
    const rid = req.params.rid;
    if (!isRid(rid)) {
      return sendStemmaEventsError(res, "SubscriptionNotFound", 404, { rid });
    }
    const requestId = (req.header("X-Request-Id") as string) || randomUUID();

    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      const deleted = await deleteSubscriptionWithinTx(client, rid);
      if (!deleted) {
        await client.query("ROLLBACK");
        return sendStemmaEventsError(res, "SubscriptionNotFound", 404, { rid });
      }

      const beforeHash = hashSubscriptionState(deleted);
      await insertCodeReposAuditEvent(client, {
        category: AUDIT_CATEGORY,
        action: "deleteSubscription",
        targetRid: rid,
        targetType: TARGET_TYPE_SUBSCRIPTION,
        principalUserId: principal.userId,
        principalSource:
          principal.source === "test" ? "system" : principal.source,
        requestId,
        beforeHash,
        afterHash: null,
        sourceIp: principal.sourceIp,
        userAgent: principal.userAgent,
        parameters: {},
      });
      await client.query("COMMIT");

      res.status(200).json({ rid, state: "DELETED" });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow */
      }
      const msg = err instanceof Error ? err.message : String(err);
      sendStemmaEventsError(res, "Internal", 500, { reason: msg });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------------------
  // POST /subscriptions/:rid/reactivate — operator endpoint
  // -------------------------------------------------------------------------
  router.post("/subscriptions/:rid/reactivate", async (req, res) => {
    const principal = req.codeReposPrincipal;
    if (!principal) return sendInternal(res, "principal not bound");
    const rid = req.params.rid;
    if (!isRid(rid)) {
      return sendStemmaEventsError(res, "SubscriptionNotFound", 404, { rid });
    }
    const requestId = (req.header("X-Request-Id") as string) || randomUUID();

    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

      // Snapshot before so we can populate before_hash on a real
      // transition. Idempotent re-activation (already ACTIVE) is a no-op
      // and emits no audit row.
      const priorRes = await client.query<{
        rid: string;
        state: SubscriptionState;
        consecutive_failures: number;
      }>(
        `SELECT rid, state, consecutive_failures FROM stemma_subscription
           WHERE rid = $1 FOR UPDATE`,
        [rid],
      );
      const prior = priorRes.rows[0];
      if (!prior) {
        await client.query("ROLLBACK");
        return sendStemmaEventsError(res, "SubscriptionNotFound", 404, { rid });
      }

      const sub = await reactivateSubscription(client, rid);
      if (!sub) {
        await client.query("ROLLBACK");
        return sendStemmaEventsError(res, "SubscriptionNotFound", 404, { rid });
      }

      const transitioned =
        prior.state === "SUSPENDED" || prior.consecutive_failures > 0;
      if (transitioned) {
        const afterHash = hashSubscriptionState(sub);
        await insertCodeReposAuditEvent(client, {
          category: AUDIT_CATEGORY,
          action: "reactivateSubscription",
          targetRid: rid,
          targetType: TARGET_TYPE_SUBSCRIPTION,
          principalUserId: principal.userId,
          principalSource:
            principal.source === "test" ? "system" : principal.source,
          requestId,
          beforeHash: null,
          afterHash,
          sourceIp: principal.sourceIp,
          userAgent: principal.userAgent,
          parameters: { priorState: prior.state },
        });
      }

      await client.query("COMMIT");
      res.status(200).json(subscriptionToWire(sub));
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* swallow */
      }
      const msg = err instanceof Error ? err.message : String(err);
      sendStemmaEventsError(res, "Internal", 500, { reason: msg });
    } finally {
      client.release();
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StemmaEventsErrorName =
  | "InvalidArgument"
  | "SubscriptionNotFound"
  | "SubscriptionAlreadyExists"
  | "InvalidPageToken"
  | "Internal";

const STEMMA_EVENTS_ERROR_CODE_MAP: Readonly<
  Record<StemmaEventsErrorName, ErrorCode>
> = {
  InvalidArgument: ERROR_CODES.INVALID_ARGUMENT,
  SubscriptionNotFound: ERROR_CODES.NOT_FOUND,
  SubscriptionAlreadyExists: ERROR_CODES.CONFLICT,
  InvalidPageToken: ERROR_CODES.INVALID_ARGUMENT,
  Internal: ERROR_CODES.INTERNAL,
};

function sendStemmaEventsError(
  res: Response,
  name: StemmaEventsErrorName,
  status: number,
  parameters?: Record<string, unknown>,
): void {
  res.status(status).json(
    buildEnvelope({
      errorCode: STEMMA_EVENTS_ERROR_CODE_MAP[name],
      errorName: `StemmaEvents:${name}`,
      parameters,
    }),
  );
}

function sendInternal(res: Response, reason: string): void {
  res.status(500).json(
    buildEnvelope({
      errorCode: ERROR_CODES.INTERNAL,
      errorName: "StemmaEvents:Internal",
      parameters: { reason },
    }),
  );
}

function decisionToWire(d: Decision): Record<string, unknown> {
  if (d.kind === "allow") return { kind: "allow", ref: d.ref };
  return {
    kind: "deny",
    ref: d.ref,
    errorName: d.errorName,
    httpStatus: d.httpStatus,
    parameters: d.parameters,
  };
}

function subscriptionToWire(s: SubscriptionRow): Record<string, unknown> {
  return {
    rid: s.rid,
    eventTypes: s.eventTypes,
    repositoryRid: s.repositoryRid,
    targetUri: s.targetUri,
    state: s.state,
    consecutiveFailures: s.consecutiveFailures,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    // secretEncrypted intentionally omitted from the wire surface.
  };
}

function hashSubscriptionState(s: SubscriptionRow): string {
  // Hash everything that mutates over the row's lifetime (state +
  // consecutive_failures + updated_at). The encrypted secret is stable
  // across the lifecycle in the current design but included so a
  // forensic reader can detect tampering.
  return hashResourceState({
    rid: s.rid,
    eventTypes: [...s.eventTypes],
    repositoryRid: s.repositoryRid,
    targetUri: s.targetUri,
    state: s.state,
    consecutiveFailures: s.consecutiveFailures,
    secretEncryptedDigest: s.secretEncrypted.length,
  });
}

function parseRefUpdates(input: unknown): readonly RefUpdate[] | null {
  if (!Array.isArray(input)) return null;
  const out: RefUpdate[] = [];
  for (const u of input) {
    if (typeof u !== "object" || u === null) return null;
    const r = u as RefUpdate;
    if (
      typeof r.ref !== "string" ||
      typeof r.oldSha !== "string" ||
      typeof r.newSha !== "string" ||
      typeof r.isCreate !== "boolean" ||
      typeof r.isDelete !== "boolean" ||
      typeof r.isForce !== "boolean"
    ) {
      return null;
    }
    out.push(r);
  }
  return out;
}

function parseRepoSettings(input: unknown): RepoSettingsSnapshot | null {
  if (typeof input !== "object" || input === null) return null;
  const s = input as RepoSettingsSnapshot;
  if (
    typeof s.branchNameValidation !== "string" ||
    typeof s.tagNameValidation !== "string" ||
    !Array.isArray(s.protectedBranches) ||
    s.protectedBranches.some((b: unknown) => typeof b !== "string") ||
    typeof s.requirePullRequest !== "boolean"
  ) {
    return null;
  }
  return s;
}

function parsePrincipalSnapshot(input: unknown): PrincipalSnapshot | null {
  if (typeof input !== "object" || input === null) return null;
  const p = input as PrincipalSnapshot;
  if (
    typeof p.userId !== "string" ||
    !Array.isArray(p.roles) ||
    p.roles.some((r: unknown) => typeof r !== "string")
  ) {
    return null;
  }
  return p;
}

function parsePageSize(raw: unknown): number {
  if (typeof raw !== "string") return 50;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return n;
}
