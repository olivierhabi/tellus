// ---------------------------------------------------------------------------
// chatSessionStore — persistent chat-session store for the Code Assistant
// panel (migration 126).
//
// Per-user (`principal_sub`), per-repo session + transcript store that lets a
// user save the conversation they had with the coding assistant while editing
// a file in a code-repository, then resume it later (from any browser, since
// the store lives in Postgres, not localStorage). Sessions are PRIVATE to the
// caller — the route always filters on `principal_sub`, mirroring the
// uncommitted-drafts store (104).
//
// Convention follows `drafts/draftStore.ts`:
//   - Thin function module (no repo/class); each op is an exported async fn
//     taking a `Pool` (list/get/delete) or grabbing a `PoolClient` for atomic
//     multi-statement writes (create/update).
//   - Plain `pool.query<TDbRow>(sql, $1..$n)` with positional params; a small
//     `toRow()` helper maps snake_case → camelCase for the route layer.
//   - The route layer NEVER embeds `principal_sub` from the request body;
//     it derives it from `req.codeReposPrincipal` (see routes.ts →
//     `derivePrincipalSubUuid`) and threads it through here. IDOR attempts
//     ("read another user's session by id") return null/0-row (404 in the
//     route), matching the IDOR-as-404 convention (G-C-09).
//
// Atomicity:
//   `createChatSession` and `updateChatSession` both run inside one
//   `BEGIN`/`COMMIT` transaction on a grabbed `PoolClient`. The session row's
//   `message_count` is computed inside the same tx from the messages being
//   inserted, so it never drifts from the actual child rows even under a
//   crash mid-tx.
//
// Caps:
//   - MAX_SESSIONS_PER_REPO_PER_USER — soft cap on the per-repo session list.
//     A 200-session backlog on a single repo is a clear "you should be using
//     git commits" smell; we reject the 201st instead of letting the table
//     grow without bound.
//   - MAX_MESSAGES_PER_SESSION — guards against a pathologically long single
//     transcript (a runaway agent loop, or a script dumping a log into the
//     chat). 500 turns is well past any natural coding conversation.
//   - MAX_MESSAGE_CONTENT_BYTES — single-message byte cap (64 KiB). The agent
//     answer for "refactor this 10k-line file" is NOT inlined into a single
//     message; it's surfaced as a `file_proposal` (which the FE persists
//     separately as an uncommitted draft). 64 KiB comfortably fits any
//     natural markdown answer.
//   - MAX_MESSAGE_METADATA_BYTES — 256 KiB cap on the round-trip UI metadata
//     blob. Held by a tool-call args JSON, an inline AiCodeChangesPanel
//     payload, and a Gemini "thinking" trace combined — but never a full
//     file.
// ---------------------------------------------------------------------------

import type { Pool, PoolClient } from "pg";

export const MAX_SESSIONS_PER_REPO_PER_USER = 200;
export const MAX_MESSAGES_PER_SESSION = 500;
export const MAX_MESSAGE_CONTENT_BYTES = 64 * 1024; // 64 KiB
export const MAX_MESSAGE_METADATA_BYTES = 256 * 1024; // 256 KiB
export const MAX_TITLE_LENGTH = 200;
export const MAX_BRANCH_LENGTH = 255;
export const MAX_FILE_PATH_LENGTH = 1024;
export const MAX_MODEL_ID_LENGTH = 200;

const VALID_ASSISTANT_PATHS = ["typescript-v2", "python-transform"] as const;
const VALID_MODES = ["generate", "review", "modify"] as const;

/** Wire shape for a single message in a POST/PUT body. */
export interface ChatMessageInput {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly metadata?: Record<string, unknown> | null;
}

/** Session-level fields the FE sends. `assistantPath` is immutable after
 *  create (a saved Python-transform session stays a Python session). */
export interface ChatSessionInput {
  readonly assistantPath: "typescript-v2" | "python-transform";
  readonly title?: string;
  readonly branch?: string | null;
  readonly lastActiveFilePath?: string | null;
  readonly modelId?: string | null;
  readonly mode?: "generate" | "review" | "modify" | null;
}

/** A session row WITHOUT message bodies — the `GET /:rid/chat-sessions`
 *  list response. */
export interface ChatSessionRow {
  readonly sessionId: string;
  readonly assistantPath: "typescript-v2" | "python-transform";
  readonly title: string;
  readonly branch: string | null;
  readonly lastActiveFilePath: string | null;
  readonly modelId: string | null;
  readonly mode: "generate" | "review" | "modify" | null;
  readonly messageCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A message row as returned from `GET /:rid/chat-sessions/:sessionId`. */
export interface ChatMessageRow {
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: string;
}

/** `ChatSessionRow` + its messages, returned by getSession / create /
 *  update. */
export interface ChatSessionWithMessages extends ChatSessionRow {
  readonly messages: ChatMessageRow[];
}

/** Shared invalid-result shape across create + update + the per-field helpers.
 *  Tagged with `kind: "invalid"` AND `errorName` so the outer validators can
 *  short-circuit `return r` without re-wrapping, and the route handler can
 *  `codeReposError(r.errorName, r.parameters)` uniformly. */
export type ChatInvalid =
  | { kind: "invalid"; errorName: "CodeRepos:InvalidSettings"; parameters: Record<string, unknown> }
  | { kind: "invalid"; errorName: "CodeRepos:ChatSessionTooLarge"; parameters: Record<string, unknown> }
  | { kind: "invalid"; errorName: "CodeRepos:ChatSessionLimitExceeded"; parameters: Record<string, unknown> };

/** Discriminated result of the create validator. */
export type ChatSessionValidation =
  | {
      kind: "ok";
      session: Omit<ChatSessionInput, "assistantPath"> &
        Required<Pick<ChatSessionInput, "assistantPath">>;
      messages: ChatMessageInput[];
    }
  | ChatInvalid;

/** Discriminated result of the update validator. */
export type ChatSessionUpdateValidation =
  | {
      kind: "ok";
      patch: ChatSessionPatch;
      messages: ChatMessageInput[] | null;
    }
  | ChatInvalid;

export interface ChatSessionPatch {
  title?: string;
  branch?: string | null;
  lastActiveFilePath?: string | null;
  modelId?: string | null;
  mode?: "generate" | "review" | "modify" | null;
}

/** Per-field result: `kind: "ok"` carries the validated value; `kind:
 *  "invalid"` carries an error envelope the outer validator forwards
 *  verbatim. */
type Result<T> = { kind: "ok"; value: T } | ChatInvalid;

function ok<T>(value: T): Result<T> {
  return { kind: "ok", value };
}
function invalid(field: string, reason: string): ChatInvalid {
  return { kind: "invalid", errorName: "CodeRepos:InvalidSettings", parameters: { field, reason } };
}
function tooLarge(field: string, limit: number, length?: number): ChatInvalid {
  return {
    kind: "invalid",
    errorName: "CodeRepos:ChatSessionTooLarge",
    parameters: length === undefined ? { field, limit } : { field, limit, length },
  };
}

interface ChatSessionRowDb {
  session_id: string;
  principal_sub: string;
  repository_rid: string;
  assistant_path: string;
  title: string;
  branch: string | null;
  last_active_file_path: string | null;
  model_id: string | null;
  mode: string | null;
  message_count: number;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ChatMessageRowDb {
  seq: number;
  role: "user" | "assistant";
  content: string;
  metadata: unknown;
  created_at: string | Date;
}

function toSessionRow(r: ChatSessionRowDb): ChatSessionRow {
  return {
    sessionId: r.session_id,
    assistantPath: r.assistant_path as "typescript-v2" | "python-transform",
    title: r.title,
    branch: r.branch,
    lastActiveFilePath: r.last_active_file_path,
    modelId: r.model_id,
    mode: r.mode as "generate" | "review" | "modify" | null,
    messageCount: r.message_count,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

function toMessageRow(r: ChatMessageRowDb): ChatMessageRow {
  const md = r.metadata;
  const metadata =
    md == null || typeof md !== "object" || Array.isArray(md)
      ? null
      : (md as Record<string, unknown>);
  return {
    seq: r.seq,
    role: r.role,
    content: r.content,
    metadata,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

const SESSION_SELECT_COLS =
  "session_id, principal_sub, repository_rid, assistant_path, title, branch, " +
  "last_active_file_path, model_id, mode, message_count, created_at, updated_at";

// ---------------------------------------------------------------------------
// Pure body validators.
// ---------------------------------------------------------------------------

/** Pure body validator for `POST /:rid/chat-sessions`. Mirrors
 *  `drafts/draftStore.ts:validateDraftsBody`: hand-rolled, returns a
 *  discriminated outcome the route maps 1:1 to a §1.3 error envelope. */
export function validateCreateChatSessionBody(body: unknown): ChatSessionValidation {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return invalid("body", "expected an object");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.assistantPath !== "string" || !isAssistantPath(b.assistantPath)) {
    return invalid("assistantPath", "must be 'typescript-v2' or 'python-transform'");
  }
  const assistantPath = b.assistantPath;

  const titleR = validateStringOrUndefined(b.title, "title", MAX_TITLE_LENGTH);
  if (titleR.kind === "invalid") return titleR;
  const title = titleR.value;

  const branchR = validateNullableString(b.branch, "branch", MAX_BRANCH_LENGTH);
  if (branchR.kind === "invalid") return branchR;
  const branch = branchR.value;

  const pathR = validateNullableString(b.lastActiveFilePath, "lastActiveFilePath", MAX_FILE_PATH_LENGTH);
  if (pathR.kind === "invalid") return pathR;
  const lastActiveFilePath = pathR.value;

  const modelR = validateNullableString(b.modelId, "modelId", MAX_MODEL_ID_LENGTH);
  if (modelR.kind === "invalid") return modelR;
  const modelId = modelR.value;

  const modeR = validateMode(b.mode);
  if (modeR.kind === "invalid") return modeR;
  const mode = modeR.value;

  const msgsR = validateMessages(b.messages);
  if (msgsR.kind === "invalid") return msgsR;
  const messages = msgsR.value;

  return {
    kind: "ok",
    session: {
      assistantPath,
      title: title || "Untitled session",
      branch,
      lastActiveFilePath,
      modelId,
      mode,
    },
    messages,
  };
}

/** Pure body validator for `PUT /:rid/chat-sessions/:sessionId`. The session
 *  itself (`assistantPath`) is immutable; the caller may replace any of its
 *  metadata fields and/or its full message set. */
export function validateUpdateChatSessionBody(body: unknown): ChatSessionUpdateValidation {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return invalid("body", "expected an object");
  }
  const b = body as Record<string, unknown>;

  const patch: ChatSessionPatch = {};

  if (b.title !== undefined) {
    const t = validateStringOrUndefined(b.title, "title", MAX_TITLE_LENGTH);
    if (t.kind === "invalid") return t;
    patch.title = t.value || "Untitled session";
  }
  if (b.branch !== undefined) {
    const r = validateNullableString(b.branch, "branch", MAX_BRANCH_LENGTH);
    if (r.kind === "invalid") return r;
    patch.branch = r.value;
  }
  if (b.lastActiveFilePath !== undefined) {
    const r = validateNullableString(b.lastActiveFilePath, "lastActiveFilePath", MAX_FILE_PATH_LENGTH);
    if (r.kind === "invalid") return r;
    patch.lastActiveFilePath = r.value;
  }
  if (b.modelId !== undefined) {
    const r = validateNullableString(b.modelId, "modelId", MAX_MODEL_ID_LENGTH);
    if (r.kind === "invalid") return r;
    patch.modelId = r.value;
  }
  if (b.mode !== undefined) {
    const r = validateMode(b.mode);
    if (r.kind === "invalid") return r;
    patch.mode = r.value;
  }

  let messages: ChatMessageInput[] | null = null;
  if (b.messages !== undefined) {
    const r = validateMessages(b.messages);
    if (r.kind === "invalid") return r;
    messages = r.value;
  }

  return { kind: "ok", patch, messages };
}

function isAssistantPath(s: string): s is "typescript-v2" | "python-transform" {
  return (VALID_ASSISTANT_PATHS as readonly string[]).includes(s);
}

function validateStringOrUndefined(
  value: unknown,
  field: string,
  maxLen: number,
): Result<string> {
  if (value === undefined || value === null) return ok("Untitled session");
  if (typeof value !== "string") return invalid(field, "must be a string");
  if (value.length > maxLen) return tooLarge(field, maxLen, value.length);
  return ok(value);
}

function validateNullableString(
  value: unknown,
  field: string,
  maxLen: number,
): Result<string | null> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== "string") {
    return invalid(field, "must be a string or null");
  }
  if (value.length > maxLen) return tooLarge(field, maxLen, value.length);
  return ok(value);
}

function validateMode(value: unknown): Result<"generate" | "review" | "modify" | null> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== "string" || !(VALID_MODES as readonly string[]).includes(value)) {
    return invalid("mode", "must be 'generate', 'review', or 'modify'");
  }
  return ok(value as "generate" | "review" | "modify");
}

function validateMessages(value: unknown): Result<ChatMessageInput[]> {
  if (!Array.isArray(value)) {
    return invalid("messages", "expected an array");
  }
  if (value.length > MAX_MESSAGES_PER_SESSION) {
    return tooLarge("messages", MAX_MESSAGES_PER_SESSION, value.length);
  }
  const out: ChatMessageInput[] = [];
  for (let i = 0; i < value.length; i++) {
    const m = value[i];
    if (m == null || typeof m !== "object" || Array.isArray(m)) {
      return invalid(`messages[${i}]`, "expected an object");
    }
    const mm = m as { role?: unknown; content?: unknown; metadata?: unknown };
    if (mm.role !== "user" && mm.role !== "assistant") {
      return invalid(`messages[${i}].role`, "must be 'user' or 'assistant'");
    }
    if (typeof mm.content !== "string") {
      return invalid(`messages[${i}].content`, "must be a string");
    }
    if (Buffer.byteLength(mm.content, "utf8") > MAX_MESSAGE_CONTENT_BYTES) {
      return tooLarge(`messages[${i}].content`, MAX_MESSAGE_CONTENT_BYTES);
    }
    let metadata: Record<string, unknown> | null = null;
    if (mm.metadata !== undefined && mm.metadata !== null) {
      if (typeof mm.metadata !== "object" || Array.isArray(mm.metadata)) {
        return invalid(`messages[${i}].metadata`, "must be an object or null");
      }
      const blob = JSON.stringify(mm.metadata);
      if (Buffer.byteLength(blob, "utf8") > MAX_MESSAGE_METADATA_BYTES) {
        return tooLarge(`messages[${i}].metadata`, MAX_MESSAGE_METADATA_BYTES);
      }
      metadata = mm.metadata as Record<string, unknown>;
    }
    out.push({ role: mm.role, content: mm.content, metadata });
  }
  return ok(out);
}

// ---------------------------------------------------------------------------
// Query helpers.
// ---------------------------------------------------------------------------

export interface ChatSessionStoreArgs {
  readonly principalSub: string;
  readonly repositoryRid: string;
}

/** List the caller's sessions for a repo, newest first. Does NOT return
 *  message bodies — the list call is for the picker; messages are fetched
 *  on demand by `GET /:rid/chat-sessions/:sessionId`. */
export async function listChatSessions(
  pool: Pool,
  args: ChatSessionStoreArgs,
): Promise<ChatSessionRow[]> {
  const res = await pool.query<ChatSessionRowDb>(
    `SELECT ${SESSION_SELECT_COLS} FROM code_repository_chat_session
      WHERE principal_sub = $1 AND repository_rid = $2
      ORDER BY updated_at DESC, session_id`,
    [args.principalSub, args.repositoryRid],
  );
  return res.rows.map(toSessionRow);
}

/** Get one session + its messages, OR null if the session doesn't exist OR
 *  exists but belongs to a different `principal_sub` (IDOR-as-null). */
export async function getChatSession(
  pool: Pool,
  args: ChatSessionStoreArgs & { sessionId: string },
): Promise<ChatSessionWithMessages | null> {
  const sess = await pool.query<ChatSessionRowDb>(
    `SELECT ${SESSION_SELECT_COLS} FROM code_repository_chat_session
      WHERE session_id = $1 AND principal_sub = $2 AND repository_rid = $3`,
    [args.sessionId, args.principalSub, args.repositoryRid],
  );
  if (sess.rowCount === 0 || !sess.rows[0]) return null;
  const session = toSessionRow(sess.rows[0]);

  const msgs = await pool.query<ChatMessageRowDb>(
    `SELECT seq, role, content, metadata, created_at
       FROM code_repository_chat_message
       WHERE session_id = $1
       ORDER BY seq`,
    [args.sessionId],
  );
  return { ...session, messages: msgs.rows.map(toMessageRow) };
}

/** Thrown by `createChatSession` when the per-repo per-user session cap is
 *  already reached. The route catches it and maps to
 *  `CodeRepos:ChatSessionLimitExceeded`. */
export class ChatSessionLimitExceededError extends Error {
  constructor(public readonly limit: number) {
    super(`chat-session limit reached (${limit} per repository per user)`);
    this.name = "ChatSessionLimitExceededError";
  }
}

/** Create a session + its initial message set in a single tx. Returns the
 *  full session row + messages. Throws `ChatSessionLimitExceededError` if
 *  the per-repo per-user cap is reached. */
export async function createChatSession(
  pool: Pool,
  args: ChatSessionStoreArgs & {
    session: Omit<ChatSessionInput, "assistantPath"> & Required<Pick<ChatSessionInput, "assistantPath">>;
    messages: ChatMessageInput[];
  },
): Promise<ChatSessionWithMessages> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    const countRes = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM code_repository_chat_session
        WHERE principal_sub = $1 AND repository_rid = $2`,
      [args.principalSub, args.repositoryRid],
    );
    const existing = Number(countRes.rows[0]?.c ?? "0");
    if (existing >= MAX_SESSIONS_PER_REPO_PER_USER) {
      throw new ChatSessionLimitExceededError(MAX_SESSIONS_PER_REPO_PER_USER);
    }

    const insertSession = await client.query<ChatSessionRowDb>(
      `INSERT INTO code_repository_chat_session
         (principal_sub, repository_rid, assistant_path, title, branch,
          last_active_file_path, model_id, mode, message_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${SESSION_SELECT_COLS}`,
      [
        args.principalSub,
        args.repositoryRid,
        args.session.assistantPath,
        args.session.title || "Untitled session",
        args.session.branch ?? null,
        args.session.lastActiveFilePath ?? null,
        args.session.modelId ?? null,
        args.session.mode ?? null,
        args.messages.length,
      ],
    );
    const sessionDb = insertSession.rows[0];
    if (!sessionDb) {
      throw new Error("chat-session: failed to insert session row");
    }
    const session = toSessionRow(sessionDb);
    const sessionId = sessionDb.session_id;

    const messages = await insertMessageRows(client, sessionId, args.messages, 1);

    await client.query("COMMIT");
    return { ...session, messages };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* swallow rollback errors — the original error is the real failure */
    });
    throw err;
  } finally {
    client.release();
  }
}

/** Update an existing session's metadata fields, and (optionally) atomically
 *  replace its full message set. The session must already exist and belong to
 *  the caller (IDOR-as-null). */
export async function updateChatSession(
  pool: Pool,
  args: ChatSessionStoreArgs & {
    sessionId: string;
    patch: ChatSessionPatch;
    messages: ChatMessageInput[] | null;
  },
): Promise<ChatSessionWithMessages | null> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the session row under FOR UPDATE so a concurrent PUT from the
    // same user (e.g. two browser tabs) serializes cleanly.
    const lockRes = await client.query<ChatSessionRowDb>(
      `SELECT ${SESSION_SELECT_COLS} FROM code_repository_chat_session
        WHERE session_id = $1 AND principal_sub = $2 AND repository_rid = $3
        FOR UPDATE`,
      [args.sessionId, args.principalSub, args.repositoryRid],
    );
    if (lockRes.rowCount === 0 || !lockRes.rows[0]) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown) => {
      sets.push(`${col} = $${params.length + 1}`);
      params.push(value);
    };
    if (args.patch.title !== undefined) push("title", args.patch.title);
    if (args.patch.branch !== undefined) push("branch", args.patch.branch);
    if (args.patch.lastActiveFilePath !== undefined) push("last_active_file_path", args.patch.lastActiveFilePath);
    if (args.patch.modelId !== undefined) push("model_id", args.patch.modelId);
    if (args.patch.mode !== undefined) push("mode", args.patch.mode);

    let messagesOut: ChatMessageRow[] | null = null;
    if (args.messages !== null) {
      // Replace the message set: delete all, re-insert with fresh seq,
      // update the denormalized count atomically.
      push("message_count", args.messages.length);
      await client.query(
        `DELETE FROM code_repository_chat_message WHERE session_id = $1`,
        [args.sessionId],
      );
      messagesOut = await insertMessageRows(client, args.sessionId, args.messages, 1);
    }
    if (sets.length > 0) {
      sets.push(`updated_at = now()`);
      params.push(args.sessionId, args.principalSub, args.repositoryRid);
      await client.query(
        `UPDATE code_repository_chat_session
           SET ${sets.join(", ")}
         WHERE session_id = $${params.length - 2}
           AND principal_sub = $${params.length - 1}
           AND repository_rid = $${params.length}`,
        params,
      );
    }

    const sess = await client.query<ChatSessionRowDb>(
      `SELECT ${SESSION_SELECT_COLS} FROM code_repository_chat_session
        WHERE session_id = $1 AND principal_sub = $2 AND repository_rid = $3`,
      [args.sessionId, args.principalSub, args.repositoryRid],
    );
    if (sess.rowCount === 0 || !sess.rows[0]) {
      await client.query("ROLLBACK").catch(() => {});
      return null;
    }
    const session = toSessionRow(sess.rows[0]);

    // Fetch messages fresh if we didn't already compute them above (the
    // caller may have only updated metadata).
    const messages =
      messagesOut ??
      (
        await client.query<ChatMessageRowDb>(
          `SELECT seq, role, content, metadata, created_at
             FROM code_repository_chat_message
             WHERE session_id = $1
             ORDER BY seq`,
          [args.sessionId],
        )
      ).rows.map(toMessageRow);

    await client.query("COMMIT");
    return { ...session, messages };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* swallow */
    });
    throw err;
  } finally {
    client.release();
  }
}

/** Delete one session + its messages (cascade). Returns true if a row was
 *  deleted, false if the session didn't exist or belonged to someone else. */
export async function deleteChatSession(
  pool: Pool,
  args: ChatSessionStoreArgs & { sessionId: string },
): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM code_repository_chat_session
       WHERE session_id = $1 AND principal_sub = $2 AND repository_rid = $3`,
    [args.sessionId, args.principalSub, args.repositoryRid],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Insert a full ordered message set with explicit seq starting at
 *  `startSeq`. Assumes the surrounding transaction has the session row
 *  locked. Returns the inserted rows in camelCase for the route's response
 *  payload (avoids a second round-trip on the create/update path). */
async function insertMessageRows(
  client: PoolClient,
  sessionId: string,
  messages: ChatMessageInput[],
  startSeq: number,
): Promise<ChatMessageRow[]> {
  const out: ChatMessageRow[] = [];
  for (let i = 0; i < messages.length; i++) {
    const seq = startSeq + i;
    const m = messages[i];
    const metadata = m.metadata ? JSON.stringify(m.metadata) : null;
    const inserted = await client.query<ChatMessageRowDb>(
      `INSERT INTO code_repository_chat_message
         (session_id, seq, role, content, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING seq, role, content, metadata, created_at`,
      [sessionId, seq, m.role, m.content, metadata],
    );
    const row = inserted.rows[0];
    if (row) out.push(toMessageRow(row));
  }
  return out;
}
