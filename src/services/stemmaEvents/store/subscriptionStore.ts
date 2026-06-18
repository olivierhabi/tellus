// ---------------------------------------------------------------------------
// B10 — stemma_subscription store.
//
// Spec contracts:
//   B10-C-11  Webhook subscriber registry. Per-repo OR global. Secret
//             stored encrypted. State ACTIVE | SUSPENDED.
//   B10-C-13  HMAC signature on every callback (the dispatcher uses this).
//   B10-C-14  5 consecutive failures → state = SUSPENDED.
//
// The encryption boundary is intentionally narrow: the SQL row holds
// `secret_encrypted`; the in-memory shape exposes a callback the
// dispatcher uses to materialise the plaintext only at delivery time.
// We do not pass plaintext secrets through the function-return surface.
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";
import { STEMMA_EVENT_TYPES, type StemmaEventType } from "./eventStore";

export type SubscriptionState = "ACTIVE" | "SUSPENDED";

export interface SubscriptionRow {
  readonly rid: string;
  readonly eventTypes: readonly StemmaEventType[];
  /** NULL = global; otherwise the repo this subscription is scoped to. */
  readonly repositoryRid: string | null;
  readonly targetUri: string;
  readonly state: SubscriptionState;
  readonly consecutiveFailures: number;
  readonly secretEncrypted: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateSubscriptionInput {
  readonly rid: string;
  readonly eventTypes: readonly StemmaEventType[];
  readonly repositoryRid: string | null;
  readonly targetUri: string;
  readonly secretEncrypted: string;
}

export class SubscriptionStoreError extends Error {
  public readonly code:
    | "EmptyEventTypes"
    | "UnknownEventType"
    | "TargetUriEmpty"
    | "TargetUriTooLong"
    | "AlreadyExists"
    | "NotFound"
    | "InvalidPageToken";
  constructor(code: SubscriptionStoreError["code"], message: string) {
    super(message);
    this.name = "SubscriptionStoreError";
    this.code = code;
  }
}

const TARGET_URI_MAX = 2048;
const FAILURE_THRESHOLD = 5;

/**
 * Pre-flight validation. The DB enforces these too (see migration 052),
 * but we want a structured error name BEFORE the round-trip — both for
 * latency and to avoid converting `pg` driver strings into envelopes
 * by string-matching.
 */
export function validateCreate(input: CreateSubscriptionInput): void {
  if (input.eventTypes.length === 0) {
    throw new SubscriptionStoreError(
      "EmptyEventTypes",
      "subscription must declare >= 1 event type",
    );
  }
  for (const t of input.eventTypes) {
    if (!STEMMA_EVENT_TYPES.includes(t)) {
      throw new SubscriptionStoreError(
        "UnknownEventType",
        `unknown event_type: ${t}`,
      );
    }
  }
  if (input.targetUri.length === 0) {
    throw new SubscriptionStoreError("TargetUriEmpty", "target_uri is required");
  }
  if (input.targetUri.length > TARGET_URI_MAX) {
    throw new SubscriptionStoreError(
      "TargetUriTooLong",
      `target_uri exceeds ${TARGET_URI_MAX} chars`,
    );
  }
}

type SubscriptionDbRow = {
  rid: string;
  event_types: StemmaEventType[];
  repository_rid: string | null;
  target_uri: string;
  state: SubscriptionState;
  consecutive_failures: number;
  secret_encrypted: string;
  created_at: Date;
  updated_at: Date;
};

/** Insert one subscription. Returns the row as stored. */
export async function createSubscription(
  pool: Pool,
  input: CreateSubscriptionInput,
): Promise<SubscriptionRow> {
  validateCreate(input);
  try {
    const r = await pool.query<SubscriptionDbRow>(
      `INSERT INTO stemma_subscription
         (rid, event_types, repository_rid, target_uri, secret_encrypted)
       VALUES ($1, $2::text[], $3, $4, $5)
       RETURNING *`,
      [
        input.rid,
        input.eventTypes as unknown as string[],
        input.repositoryRid,
        input.targetUri,
        input.secretEncrypted,
      ],
    );
    return rowToSub(r.rows[0]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      // unique_violation on PRIMARY KEY (rid)
      throw new SubscriptionStoreError(
        "AlreadyExists",
        `subscription rid already exists: ${input.rid}`,
      );
    }
    throw err;
  }
}

/**
 * Tx-aware variant of {@link createSubscription} so the route handler
 * can wrap the data edit + audit insert in a single SERIALIZABLE tx
 * (G-C-52 durable-before-ack). Identical semantics; takes a PoolClient
 * already inside a BEGIN.
 */
export async function createSubscriptionWithinTx(
  client: PoolClient,
  input: CreateSubscriptionInput,
): Promise<SubscriptionRow> {
  validateCreate(input);
  try {
    const r = await client.query<SubscriptionDbRow>(
      `INSERT INTO stemma_subscription
         (rid, event_types, repository_rid, target_uri, secret_encrypted)
       VALUES ($1, $2::text[], $3, $4, $5)
       RETURNING *`,
      [
        input.rid,
        input.eventTypes as unknown as string[],
        input.repositoryRid,
        input.targetUri,
        input.secretEncrypted,
      ],
    );
    return rowToSub(r.rows[0]);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") {
      throw new SubscriptionStoreError(
        "AlreadyExists",
        `subscription rid already exists: ${input.rid}`,
      );
    }
    throw err;
  }
}

export async function getSubscription(
  pool: Pool,
  rid: string,
): Promise<SubscriptionRow | null> {
  const r = await pool.query<SubscriptionDbRow>(
    `SELECT * FROM stemma_subscription WHERE rid = $1`,
    [rid],
  );
  return r.rowCount === 1 ? rowToSub(r.rows[0]) : null;
}

/**
 * DELETE one subscription within an open tx. Returns the row that was
 * deleted (so the audit before_hash can be computed) or null if not
 * found. Returning the row keeps the route handler's RETURNING-based
 * audit pattern uniform with the create/tombstone routes.
 */
export async function deleteSubscriptionWithinTx(
  client: PoolClient,
  rid: string,
): Promise<SubscriptionRow | null> {
  const r = await client.query<SubscriptionDbRow>(
    `DELETE FROM stemma_subscription WHERE rid = $1 RETURNING *`,
    [rid],
  );
  return r.rowCount === 1 ? rowToSub(r.rows[0]) : null;
}

/**
 * Cursor-paginated subscription list.
 * Sorted by (created_at DESC, rid DESC) so the index on
 * (created_at, rid) (created in migration 052) covers the ORDER.
 *
 * When `repositoryRid` is provided, the page includes both that repo's
 * subs AND globals (repository_rid IS NULL). When omitted, returns all
 * subs across the cluster.
 *
 * Cursor stability: §1.5 requires opaque, ≥30-day-stable cursors.
 * We encode (createdAt, rid) as base64url(JSON). Since (created_at, rid)
 * never changes for a row once inserted, a token from 30 days ago still
 * positions the next page correctly today.
 */
export interface ListSubscriptionsArgs {
  readonly repositoryRid?: string;
  readonly state?: SubscriptionState;
  readonly pageSize: number;
  readonly pageToken?: string;
}

export interface ListSubscriptionsPage {
  readonly subscriptions: readonly SubscriptionRow[];
  readonly nextPageToken?: string;
}

const LIST_PAGE_MIN = 1;
const LIST_PAGE_MAX = 200;

export async function listSubscriptions(
  pool: Pool,
  args: ListSubscriptionsArgs,
): Promise<ListSubscriptionsPage> {
  const pageSize = Math.max(LIST_PAGE_MIN, Math.min(LIST_PAGE_MAX, args.pageSize));
  const wheres: string[] = [];
  const params: unknown[] = [];

  if (args.repositoryRid !== undefined) {
    params.push(args.repositoryRid);
    wheres.push(`(repository_rid = $${params.length} OR repository_rid IS NULL)`);
  }
  if (args.state !== undefined) {
    params.push(args.state);
    wheres.push(`state = $${params.length}`);
  }

  if (args.pageToken) {
    const cursor = decodeListCursor(args.pageToken);
    params.push(cursor.createdAt, cursor.rid);
    wheres.push(
      `(created_at, rid) < ($${params.length - 1}::timestamptz, $${params.length}::text)`,
    );
  }

  const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
  params.push(pageSize + 1);

  const r = await pool.query<SubscriptionDbRow>(
    `SELECT * FROM stemma_subscription
     ${whereClause}
     ORDER BY created_at DESC, rid DESC
     LIMIT $${params.length}`,
    params,
  );

  const subs = r.rows.map(rowToSub);
  if (subs.length > pageSize) {
    const lastInPage = subs[pageSize - 1];
    return {
      subscriptions: subs.slice(0, pageSize),
      nextPageToken: encodeListCursor({
        createdAt: lastInPage.createdAt.toISOString(),
        rid: lastInPage.rid,
      }),
    };
  }
  return { subscriptions: subs };
}

interface ListCursor {
  readonly createdAt: string;
  readonly rid: string;
}

function encodeListCursor(c: ListCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeListCursor(token: string): ListCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new SubscriptionStoreError("InvalidPageToken", "invalid page token");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as ListCursor).createdAt !== "string" ||
    typeof (parsed as ListCursor).rid !== "string"
  ) {
    throw new SubscriptionStoreError("InvalidPageToken", "invalid page token");
  }
  return parsed as ListCursor;
}

/**
 * List ACTIVE subscriptions that should receive `event` from `repositoryRid`.
 * A subscription matches when:
 *   - state = 'ACTIVE'
 *   - eventType is in event_types
 *   - repository_rid IS NULL (global) OR repository_rid = repositoryRid
 *
 * The partial index `stemma_subscription_active_idx` on (state, repository_rid)
 * + the GIN index on event_types make this an O(matching subscriptions)
 * lookup.
 */
export async function listMatchingActiveSubscriptions(
  pool: Pool,
  repositoryRid: string,
  eventType: StemmaEventType,
): Promise<readonly SubscriptionRow[]> {
  const r = await pool.query<SubscriptionDbRow>(
    `SELECT *
     FROM stemma_subscription
     WHERE state = 'ACTIVE'
       AND $2 = ANY(event_types)
       AND (repository_rid IS NULL OR repository_rid = $1)`,
    [repositoryRid, eventType],
  );
  return r.rows.map(rowToSub);
}

/**
 * Record a successful delivery: reset consecutive_failures to 0; bump
 * updated_at. Called by the dispatcher.
 */
export async function recordDeliverySuccess(
  client: PoolClient | Pool,
  rid: string,
): Promise<void> {
  await client.query(
    `UPDATE stemma_subscription
     SET consecutive_failures = 0,
         updated_at = now()
     WHERE rid = $1`,
    [rid],
  );
}

/**
 * Record a failed delivery: increment consecutive_failures; if the new
 * value reaches the threshold, set state = 'SUSPENDED'. Returns the
 * post-update row.
 *
 * Atomic: the increment + threshold check + state mutation happen in
 * one UPDATE so two concurrent failure-callbacks can't double-increment
 * past the threshold or race the SUSPENDED transition.
 */
export async function recordDeliveryFailure(
  client: PoolClient | Pool,
  rid: string,
): Promise<{ consecutiveFailures: number; state: SubscriptionState }> {
  const r = await client.query<{
    consecutive_failures: number;
    state: SubscriptionState;
  }>(
    `UPDATE stemma_subscription
     SET consecutive_failures = consecutive_failures + 1,
         state = CASE
                   WHEN consecutive_failures + 1 >= $2 THEN 'SUSPENDED'
                   ELSE state
                 END,
         updated_at = now()
     WHERE rid = $1
     RETURNING consecutive_failures, state`,
    [rid, FAILURE_THRESHOLD],
  );
  if (r.rowCount !== 1) {
    throw new SubscriptionStoreError(
      "NotFound",
      `subscription not found: ${rid}`,
    );
  }
  return {
    consecutiveFailures: r.rows[0].consecutive_failures,
    state: r.rows[0].state,
  };
}

/**
 * Re-activate a SUSPENDED subscription. Resets the failure counter.
 * Used by the operator-facing endpoint or a scheduled retry policy.
 */
export async function reactivateSubscription(
  client: PoolClient | Pool,
  rid: string,
): Promise<SubscriptionRow | null> {
  const r = await client.query<SubscriptionDbRow>(
    `UPDATE stemma_subscription
     SET state = 'ACTIVE',
         consecutive_failures = 0,
         updated_at = now()
     WHERE rid = $1
     RETURNING *`,
    [rid],
  );
  return r.rowCount === 1 ? rowToSub(r.rows[0]) : null;
}

export const SUBSCRIPTION_FAILURE_THRESHOLD = FAILURE_THRESHOLD;

function rowToSub(row: SubscriptionDbRow): SubscriptionRow {
  return {
    rid: row.rid,
    eventTypes: row.event_types,
    repositoryRid: row.repository_rid,
    targetUri: row.target_uri,
    state: row.state,
    consecutiveFailures: row.consecutive_failures,
    secretEncrypted: row.secret_encrypted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
