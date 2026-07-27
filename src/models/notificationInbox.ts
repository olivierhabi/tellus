// ---------------------------------------------------------------------------
// src/models/notificationInbox.ts — Phase 6.4 per-user inbox support.
//
// Backs the InApp NotificationProvider + the FE inbox reader. The model
// is intentionally small: insert on delivery + list + mark-read + count
// unread badge. The DB schema lives in migration 133.
//
// Connection semantics:
//   * `insertNotification` is callable from the worker's dispatch path
//     (an in-process pool query). NEVER from inside the actionExecutor's
//     apply transaction — the notification's recipient filter runs in
//     the worker post-commit, so the INSERT is correctly post-commit.
//   * The list/count/mark APIs are for the BE /api/v1/notifications route
//     consumed by the FE inbox.
// ---------------------------------------------------------------------------

import { query } from "../db";

export interface NotificationInboxRow {
  notification_id: string;
  recipient_user_id: string;
  template_id: string;
  template_parameters: Record<string, unknown>;
  channel: "in_app" | "email" | "slack_compatible";
  action_type_api_name: string | null;
  execution_id: string | null;
  ontology_id: string | null;
  created_at: string;
  read_at: string | null;
}

export interface InsertNotificationInput {
  recipientUserId: string;
  templateId: string;
  templateParameters?: Record<string, unknown>;
  channel?: "in_app" | "email" | "slack_compatible";
  actionTypeApiName?: string | null;
  executionId?: string | null;
  ontologyId?: string | null;
}

export async function insertNotification(
  input: InsertNotificationInput,
): Promise<NotificationInboxRow> {
  const result = await query(
    `INSERT INTO notification_inbox
       (recipient_user_id, template_id, template_parameters, channel,
        action_type_api_name, execution_id, ontology_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.recipientUserId,
      input.templateId,
      JSON.stringify(input.templateParameters ?? {}),
      input.channel ?? "in_app",
      input.actionTypeApiName ?? null,
      input.executionId ?? null,
      input.ontologyId ?? null,
    ],
  );
  return result.rows[0] as NotificationInboxRow;
}

export async function listNotificationsForUser(
  recipientUserId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
): Promise<NotificationInboxRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const sql = opts.unreadOnly
    ? `SELECT * FROM notification_inbox
        WHERE recipient_user_id = $1 AND read_at IS NULL
        ORDER BY created_at DESC
        LIMIT $2`
    : `SELECT * FROM notification_inbox
        WHERE recipient_user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`;
  const result = await query(sql, [recipientUserId, limit]);
  return result.rows as NotificationInboxRow[];
}

export async function countUnreadForUser(
  recipientUserId: string,
): Promise<number> {
  const result = await query(
    `SELECT count(*)::int AS n FROM notification_inbox
      WHERE recipient_user_id = $1 AND read_at IS NULL`,
    [recipientUserId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function markNotificationRead(
  notificationId: string,
  recipientUserId: string,
): Promise<NotificationInboxRow | null> {
  const result = await query(
    `UPDATE notification_inbox
        SET read_at = now()
      WHERE notification_id = $1 AND recipient_user_id = $2
     RETURNING *`,
    [notificationId, recipientUserId],
  );
  return (result.rows[0] as NotificationInboxRow | undefined) ?? null;
}

/** Idempotent mark-as-read for every unread row owned by the user. Used by
 * the FE inbox "marker as all read" UI gesture. */
export async function markAllNotificationsRead(
  recipientUserId: string,
): Promise<number> {
  const result = await query(
    `UPDATE notification_inbox
        SET read_at = now()
      WHERE recipient_user_id = $1 AND read_at IS NULL`,
    [recipientUserId],
  );
  return result.rowCount ?? 0;
}
