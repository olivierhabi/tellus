// ---------------------------------------------------------------------------
// commentService — Workshop Comments widget backend (Foundry parity).
//
// Docs contract (workshop/widgets-comments):
//
//   * Comments attach to a PARENT OBJECT (objectType + primaryKey) and
//     follow the parent object's permissions: every read/post/delete first
//     re-verifies parent readability through the SAME security-filtered
//     object fetch the search routes use (executeGetObject), so a user who
//     cannot read the parent can never list or post its comments — even by
//     guessing the primary key.
//   * A user may delete their own comments (soft delete).
//   * References: structured object/user mention tokens ride the row so the
//     FE renders interactive chips without re-parsing the body.
//   * Attachments: comment rows reference `ri.attachments.*` rids uploaded
//     through the existing attachment service (200 MB cap enforced there).
//   * Notifications (default behavior): commenting subscribes the author;
//     mentioning a user subscribes them AND sends an immediate notification;
//     every later comment notifies all other subscribers through the shared
//     notification_inbox (never a second, disconnected inbox).
//   * The comment service is the source of truth — mirrored Action Log rows
//     (the "Action to perform after commenting" path) never drive edits or
//     deletes.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { getWorkshopDb } from "./db";
import { executeGetObject } from "../queryExecutor";
import { buildSecurityFilter } from "../../middleware/securityContext";
import type { SecurityContext } from "../../middleware/securityContext";
import { insertNotification } from "../../models/notificationInbox";
import { resolveAccessibleAttachmentRids } from "../attachmentService";

function query(sql: string, params?: unknown[]) {
  return getWorkshopDb().query(sql, params);
}

export interface CommentReference {
  readonly kind: "object" | "user";
  // object references:
  readonly objectTypeApiName?: string;
  readonly primaryKey?: string;
  readonly displayTitle?: string;
  // user references:
  readonly userId?: string;
  readonly displayName?: string;
}

export interface CommentAttachmentRef {
  readonly rid: string;
  readonly filename: string;
  readonly sizeBytes?: number;
  readonly mediaType?: string;
}

export interface CommentRow {
  readonly commentId: string;
  readonly threadId: string;
  readonly objectTypeApiName: string;
  readonly primaryKey: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly references: CommentReference[];
  readonly attachments: CommentAttachmentRef[];
  readonly createdAt: string;
  readonly editedAt: string | null;
}

export class CommentPermissionError extends Error {
  readonly statusCode = 403;
  readonly errorName = "CommentParentObjectInaccessible";
  constructor(objectTypeApiName: string, primaryKey: string) {
    super(
      `The parent object ${objectTypeApiName}/${primaryKey} does not exist or is not visible to this user.`,
    );
  }
}

export class CommentNotFoundError extends Error {
  readonly statusCode = 404;
  readonly errorName = "CommentNotFound";
  constructor(commentId: string) {
    super(`Comment ${commentId} was not found or is already deleted.`);
  }
}

export class CommentAuthorOnlyError extends Error {
  readonly statusCode = 403;
  readonly errorName = "CommentDeleteAuthorOnly";
  constructor() {
    super("Only the author of a comment can delete it.");
  }
}

function parseReferences(raw: unknown): CommentReference[] {
  if (!Array.isArray(raw)) return [];
  const out: CommentReference[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (r.kind === "user" && typeof r.userId === "string") {
      out.push({
        kind: "user",
        userId: r.userId,
        displayName:
          typeof r.displayName === "string" ? r.displayName : undefined,
      });
    } else if (
      r.kind === "object" &&
      typeof r.objectTypeApiName === "string" &&
      typeof r.primaryKey === "string"
    ) {
      out.push({
        kind: "object",
        objectTypeApiName: r.objectTypeApiName,
        primaryKey: r.primaryKey,
        displayTitle:
          typeof r.displayTitle === "string" ? r.displayTitle : undefined,
      });
    }
  }
  return out;
}

function parseAttachments(raw: unknown): CommentAttachmentRef[] {
  if (!Array.isArray(raw)) return [];
  const out: CommentAttachmentRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const a = item as Record<string, unknown>;
    if (typeof a.rid !== "string" || typeof a.filename !== "string") continue;
    out.push({
      rid: a.rid,
      filename: a.filename,
      sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : undefined,
      mediaType: typeof a.mediaType === "string" ? a.mediaType : undefined,
    });
  }
  return out;
}

/**
 * Parent-object permission gate (docs: "Comments follow the permissions of
 * the parent object"). Runs the security-filtered single-object fetch — the
 * same path GET /objects/:type/:pk uses — so marking-restricted objects are
 * invisible here exactly as they are in search. Throws unless readable.
 */
async function requireReadableParent(
  objectTypeApiName: string,
  primaryKey: string,
  security: SecurityContext,
): Promise<void> {
  const securityFilter = buildSecurityFilter(security);
  const object = await executeGetObject(
    objectTypeApiName,
    primaryKey,
    securityFilter,
    null,
  );
  if (!object) {
    throw new CommentPermissionError(objectTypeApiName, primaryKey);
  }
}

async function getOrCreateThread(
  objectTypeApiName: string,
  primaryKey: string,
  ontologyId?: string | null,
): Promise<string> {
  const found = await query(
    `SELECT thread_id FROM comment_thread
      WHERE object_type_api_name = $1 AND primary_key = $2`,
    [objectTypeApiName, primaryKey],
  );
  if (found.rows.length > 0) return found.rows[0].thread_id as string;
  // ON CONFLICT guards the read-then-insert race between concurrent first
  // comments on the same parent object.
  const inserted = await query(
    `INSERT INTO comment_thread (object_type_api_name, primary_key, ontology_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (object_type_api_name, primary_key)
       DO UPDATE SET object_type_api_name = EXCLUDED.object_type_api_name
     RETURNING thread_id`,
    [objectTypeApiName, primaryKey, ontologyId ?? null],
  );
  return inserted.rows[0].thread_id as string;
}

async function findThread(
  objectTypeApiName: string,
  primaryKey: string,
): Promise<string | null> {
  const found = await query(
    `SELECT thread_id FROM comment_thread
      WHERE object_type_api_name = $1 AND primary_key = $2`,
    [objectTypeApiName, primaryKey],
  );
  return found.rows.length > 0 ? (found.rows[0].thread_id as string) : null;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function toCommentRow(
  row: Record<string, unknown>,
  objectTypeApiName: string,
  primaryKey: string,
): CommentRow {
  return {
    commentId: row.comment_id as string,
    threadId: row.thread_id as string,
    objectTypeApiName,
    primaryKey,
    authorUserId: row.author_user_id as string,
    body: row.body as string,
    references: parseReferences(row.references),
    attachments: parseAttachments(row.attachment_rids),
    createdAt: isoOrNull(row.created_at) ?? "",
    editedAt: isoOrNull(row.edited_at),
  };
}

export async function listComments(
  objectTypeApiName: string,
  primaryKey: string,
  security: SecurityContext,
): Promise<CommentRow[]> {
  await requireReadableParent(objectTypeApiName, primaryKey, security);
  const threadId = await findThread(objectTypeApiName, primaryKey);
  if (!threadId) return [];
  const result = await query(
    `SELECT * FROM object_comment
      WHERE thread_id = $1 AND deleted_at IS NULL
      ORDER BY created_at ASC, comment_id ASC`,
    [threadId],
  );
  const comments = result.rows.map((row: Record<string, unknown>) => toCommentRow(row, objectTypeApiName, primaryKey));
  // Finding A parity: omit attachment refs the reader could not fetch from
  // the (now access-controlled) content endpoint — visible only to the
  // uploader or to someone who can read an object the attachment is linked
  // to. Resolved in one batched pass with per-rid/per-object caching.
  const allRids = [
    ...new Set(comments.flatMap((c: CommentRow) => c.attachments.map((a) => a.rid))),
  ];
  if (allRids.length === 0) return comments;
  const visibleRids = await resolveAccessibleAttachmentRids(allRids, security);
  return comments.map((c: CommentRow) => ({
    ...c,
    attachments: c.attachments.filter((a) => visibleRids.has(a.rid)),
  }));
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function createComment({
  objectTypeApiName,
  primaryKey,
  body,
  references,
  attachments,
  security,
  ontologyId,
  sendDefaultNotifications = true,
}: {
  readonly objectTypeApiName: string;
  readonly primaryKey: string;
  readonly body: string;
  readonly references?: unknown;
  readonly attachments?: unknown;
  readonly security: SecurityContext;
  readonly ontologyId?: string | null;
  readonly sendDefaultNotifications?: boolean;
}): Promise<CommentRow> {
  const trimmed = typeof body === "string" ? body.trim() : "";
  if (!trimmed) {
    throw Object.assign(new Error("Comment body must not be empty."), {
      statusCode: 400,
      errorName: "CommentBodyEmpty",
    });
  }
  if (trimmed.length > 10_000) {
    throw Object.assign(new Error("Comment body exceeds 10,000 characters."), {
      statusCode: 400,
      errorName: "CommentBodyTooLong",
    });
  }
  await requireReadableParent(objectTypeApiName, primaryKey, security);
  const threadId = await getOrCreateThread(
    objectTypeApiName,
    primaryKey,
    ontologyId,
  );
  const refs = parseReferences(references);
  const atts = parseAttachments(attachments);
  const inserted = await query(
    `INSERT INTO object_comment
       (thread_id, author_user_id, body, "references", attachment_rids)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      threadId,
      security.userId,
      trimmed,
      JSON.stringify(refs),
      JSON.stringify(atts),
    ],
  );
  const comment = toCommentRow(
    inserted.rows[0],
    objectTypeApiName,
    primaryKey,
  );

  // Default-notification behavior (docs): the author is auto-subscribed;
  // mentioned users are subscribed AND notified; all other subscribers are
  // notified of the new comment. Failures in notification dispatch must
  // never roll back the comment itself — the inbox is best-effort.
  try {
    await subscribe(threadId, security.userId);
    const mentionedUserIds = [
      ...new Set(
        refs
          .filter((r) => r.kind === "user" && UUID_RE.test(r.userId ?? ""))
          .map((r) => r.userId as string),
      ),
    ];
    for (const userId of mentionedUserIds) {
      await subscribe(threadId, userId);
    }
    if (sendDefaultNotifications) {
      const notify = new Set<string>([
        ...(await subscriberIds(threadId)),
        ...mentionedUserIds,
      ]);
      notify.delete(security.userId);
      const preview =
        trimmed.length > 140 ? `${trimmed.slice(0, 140)}…` : trimmed;
      for (const recipientUserId of notify) {
        await insertNotification({
          recipientUserId,
          templateId: "workshop_comment",
          templateParameters: {
            actor: security.userId,
            objectTypeApiName,
            primaryKey,
            commentId: comment.commentId,
            preview,
            mentioned: mentionedUserIds.includes(recipientUserId),
          },
          channel: "in_app",
          ontologyId: null,
        });
      }
    }
  } catch (err) {
    console.warn(
      `[comments] notification dispatch failed for ${comment.commentId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return comment;
}

export async function deleteComment(
  commentId: string,
  security: SecurityContext,
): Promise<void> {
  const found = await query(
    `SELECT c.comment_id, c.author_user_id, t.object_type_api_name, t.primary_key
       FROM object_comment c
       JOIN comment_thread t ON t.thread_id = c.thread_id
      WHERE c.comment_id = $1 AND c.deleted_at IS NULL`,
    [commentId],
  );
  if (found.rows.length === 0) throw new CommentNotFoundError(commentId);
  const row = found.rows[0];
  // Deleting follows the parent object too: an author who lost read access
  // to the parent cannot delete (their comment is as hidden as the parent).
  await requireReadableParent(
    row.object_type_api_name as string,
    row.primary_key as string,
    security,
  );
  // Docs: "You can also delete your own comments" — author-only.
  if (row.author_user_id !== security.userId) {
    throw new CommentAuthorOnlyError();
  }
  await query(
    `UPDATE object_comment SET deleted_at = now() WHERE comment_id = $1`,
    [commentId],
  );
}

export async function subscribe(
  threadId: string,
  userId: string,
): Promise<void> {
  await query(
    `INSERT INTO comment_thread_subscription (thread_id, user_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [threadId, userId],
  );
}

async function subscriberIds(threadId: string): Promise<string[]> {
  const result = await query(
    `SELECT user_id FROM comment_thread_subscription WHERE thread_id = $1`,
    [threadId],
  );
  return result.rows.map((r: Record<string, unknown>) => r.user_id as string);
}

// `randomUUID` re-export keeps the service's id generation injectable in
// tests without importing node:crypto in every consumer.
export const newCommentId = randomUUID;
