// ---------------------------------------------------------------------------
// B10 — stemma_event store (Postgres-backed event log).
//
// Spec contracts:
//   B10-C-03  Post-receive: write one stemma_event per ref-update; this
//             write is the source of truth for `GET /events` queries.
//   B10-C-12  `GET /events?repositoryRid=&since=&pageSize=&pageToken=`
//             cursor-paginated; deterministic ordering on
//             (occurred_at DESC, rid DESC) so a cursor never skips rows.
//   §1.5      Cursor pagination: opaque base64-encoded JSON cursor
//             carrying { occurredAt: ISO, rid: string }.
//
// Keeping the row-shape and the cursor encoding in one module so a future
// schema change updates both call sites in one diff.
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";
import { Buffer } from "node:buffer";
import {
  ERROR_CODES,
  buildEnvelope,
  type ErrorEnvelope,
} from "../../codeRepos/contracts/errors";

export type StemmaEventType =
  | "PUSH"
  | "MERGE"
  | "TAG"
  | "PR_OPENED"
  | "PR_MERGED"
  | "PR_CLOSED"
  | "BRANCH_CREATED"
  | "BRANCH_DELETED";

export const STEMMA_EVENT_TYPES: readonly StemmaEventType[] = [
  "PUSH",
  "MERGE",
  "TAG",
  "PR_OPENED",
  "PR_MERGED",
  "PR_CLOSED",
  "BRANCH_CREATED",
  "BRANCH_DELETED",
] as const;

export interface StemmaEventInput {
  readonly rid: string;
  readonly repositoryRid: string;
  readonly eventType: StemmaEventType;
  readonly ref: string | null;
  readonly oldSha: string | null;
  readonly newSha: string | null;
  readonly principalSub: string | null;
  readonly payload: Record<string, unknown>;
}

export interface StemmaEvent extends StemmaEventInput {
  readonly occurredAt: Date;
}

export interface ListEventsArgs {
  readonly repositoryRid?: string;
  readonly eventType?: StemmaEventType;
  /** ISO-8601 lower bound on `occurred_at`. Inclusive. */
  readonly since?: string;
  readonly pageSize: number;
  /** Opaque cursor from a prior page response. Undefined for the first page. */
  readonly pageToken?: string;
}

export interface ListEventsPage {
  readonly events: readonly StemmaEvent[];
  /** Opaque next-page cursor; undefined when this is the final page. */
  readonly nextPageToken?: string;
}

interface CursorState {
  readonly occurredAt: string;
  readonly rid: string;
}

const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 200;

/**
 * Insert one event row inside an existing transaction. The caller owns
 * the tx so the event write can be atomic with the audit row + any
 * outbox enqueue. Throws if the row violates a CHECK (callers should
 * pre-validate; the throw here is fail-closed).
 */
export async function insertEventWithinTx(
  client: PoolClient,
  event: StemmaEventInput,
): Promise<StemmaEvent> {
  const r = await client.query<{
    occurred_at: Date;
  }>(
    `INSERT INTO stemma_event
       (rid, repository_rid, event_type, ref, old_sha, new_sha,
        principal_sub, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING occurred_at`,
    [
      event.rid,
      event.repositoryRid,
      event.eventType,
      event.ref,
      event.oldSha,
      event.newSha,
      event.principalSub,
      JSON.stringify(event.payload),
    ],
  );
  return {
    ...event,
    occurredAt: r.rows[0].occurred_at,
  };
}

/**
 * List events with cursor pagination. Sorted by `(occurred_at DESC, rid DESC)`
 * so the (occurred_at, rid) compound index from migration 052 is hit
 * directly. The cursor is the (occurred_at, rid) pair of the LAST row
 * of the previous page; the next page starts from the row strictly
 * after that pair under the same ordering.
 */
export async function listEvents(
  pool: Pool,
  args: ListEventsArgs,
): Promise<ListEventsPage> {
  const pageSize = clampPageSize(args.pageSize);
  const cursor = args.pageToken ? decodeCursor(args.pageToken) : undefined;

  const wheres: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  if (args.repositoryRid) {
    wheres.push(`repository_rid = $${p++}`);
    params.push(args.repositoryRid);
  }
  if (args.eventType) {
    wheres.push(`event_type = $${p++}`);
    params.push(args.eventType);
  }
  if (args.since) {
    wheres.push(`occurred_at >= $${p++}::timestamptz`);
    params.push(args.since);
  }
  if (cursor) {
    // Composite-key < cursor; equivalent to (occurred_at < c.t) OR
    // (occurred_at = c.t AND rid < c.rid). The form on the right is
    // index-friendly and Postgres can short-circuit on the first
    // disjunct.
    wheres.push(
      `(occurred_at, rid) < ($${p++}::timestamptz, $${p++}::text)`,
    );
    params.push(cursor.occurredAt);
    params.push(cursor.rid);
  }

  // Fetch one extra row to determine whether there's a next page without
  // a separate count query.
  const limit = pageSize + 1;
  params.push(limit);
  const limitParam = `$${p++}`;

  const sql = `SELECT rid, repository_rid, event_type, ref, old_sha, new_sha,
                      principal_sub, occurred_at, payload
               FROM stemma_event
               ${wheres.length ? `WHERE ${wheres.join(" AND ")}` : ""}
               ORDER BY occurred_at DESC, rid DESC
               LIMIT ${limitParam}`;

  const r = await pool.query<{
    rid: string;
    repository_rid: string;
    event_type: StemmaEventType;
    ref: string | null;
    old_sha: string | null;
    new_sha: string | null;
    principal_sub: string | null;
    occurred_at: Date;
    payload: Record<string, unknown>;
  }>(sql, params);

  const rows = r.rows.slice(0, pageSize);
  const events: StemmaEvent[] = rows.map((row) => ({
    rid: row.rid,
    repositoryRid: row.repository_rid,
    eventType: row.event_type,
    ref: row.ref,
    oldSha: row.old_sha,
    newSha: row.new_sha,
    principalSub: row.principal_sub,
    occurredAt: row.occurred_at,
    payload: row.payload ?? {},
  }));

  let nextPageToken: string | undefined;
  if (r.rows.length > pageSize) {
    const last = events[events.length - 1];
    nextPageToken = encodeCursor({
      occurredAt: last.occurredAt.toISOString(),
      rid: last.rid,
    });
  }

  return { events, nextPageToken };
}

/**
 * Encode an opaque, URL-safe cursor. The token is base64url(JSON({...})).
 * Stable for ≥30 days per §1.5: any future schema change must keep the
 * (occurredAt, rid) fields, or bump the encoding's version prefix and
 * keep a parser for the old shape.
 */
export function encodeCursor(state: CursorState): string {
  const payload = JSON.stringify(state);
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(token: string): CursorState {
  let payload: string;
  try {
    payload = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    throw cursorError("malformed");
  }
  try {
    const parsed = JSON.parse(payload) as Partial<CursorState>;
    if (
      typeof parsed.occurredAt !== "string" ||
      typeof parsed.rid !== "string"
    ) {
      throw cursorError("malformed");
    }
    // Validate the timestamp is parseable — invalid dates would make the
    // SQL cast throw with a confusing error.
    const t = Date.parse(parsed.occurredAt);
    if (!Number.isFinite(t)) {
      throw cursorError("malformed");
    }
    return { occurredAt: parsed.occurredAt, rid: parsed.rid };
  } catch (err) {
    if (err instanceof CursorError) throw err;
    throw cursorError("malformed");
  }
}

export class CursorError extends Error {
  public readonly envelope: ErrorEnvelope;
  public readonly httpStatus: 400 = 400;
  constructor(envelope: ErrorEnvelope) {
    super(envelope.errorName);
    this.name = "CursorError";
    this.envelope = envelope;
  }
}

function cursorError(reason: "malformed"): CursorError {
  return new CursorError(
    buildEnvelope({
      errorCode: ERROR_CODES.INVALID_ARGUMENT,
      errorName: "StemmaEvents:InvalidPageToken",
      parameters: { reason },
    }),
  );
}

function clampPageSize(n: number): number {
  if (!Number.isInteger(n) || n < MIN_PAGE_SIZE) return MIN_PAGE_SIZE;
  if (n > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return n;
}
