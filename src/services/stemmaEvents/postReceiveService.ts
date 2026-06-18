// ---------------------------------------------------------------------------
// B10 — post-receive orchestrator.
//
// Spec contracts:
//   B10-C-03  Post-receive: write one stemma_event per ALLOWed ref-update,
//             then fan out to subscribers asynchronously.
//   B10-C-15  Fan-out is async — the post-receive HTTP response does NOT
//             wait for callbacks to land. Subscribers see at-least-once
//             delivery; consumers must dedup on event rid.
//   B10-C-21  When repoSettings.json was part of the push, the OLD
//             settings (passed in PushContext.settings) drive the
//             policy. We don't fetch from disk here.
//
// Pattern: caller (the HTTP route) owns the pre-receive decision and
// the policy outcome. The route invokes `recordPostReceive()` for each
// ALLOWed update; this writes the audit row, the stemma_event row,
// and (asynchronously) kicks the dispatcher. The audit + event are
// in one tx so neither lands without the other.
// ---------------------------------------------------------------------------

import type { Pool } from "pg";
import {
  insertEventWithinTx,
  type StemmaEvent,
  type StemmaEventInput,
  type StemmaEventType,
} from "./store/eventStore";
import {
  insertCodeReposAuditEvent,
  hashResourceState,
} from "../codeRepos/audit/auditEvents";
import {
  dispatchEvent,
  type DispatcherDeps,
  type DispatchResult,
} from "./dispatcher/callbackDispatcher";
import {
  mintRid,
  parseRid,
  SERVICE_NAMESPACES,
} from "../codeRepos/contracts/rid";

export interface PostReceiveInput {
  readonly repositoryRid: string;
  readonly eventType: StemmaEventType;
  readonly ref: string | null;
  readonly oldSha: string | null;
  readonly newSha: string | null;
  readonly principalUserId: string;
  readonly principalSub: string | null;
  readonly principalSource: "cookie" | "bearer-jwt" | "pat" | "system";
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly payload: Record<string, unknown>;
}

export interface PostReceiveResult {
  readonly event: StemmaEvent;
  readonly auditRowId: string;
  /** undefined when fan-out has not run yet (lazy mode). */
  readonly dispatch?: readonly DispatchResult[];
}

export interface PostReceiveDeps {
  readonly pool: Pool;
  readonly dispatcher?: DispatcherDeps;
  /** Generate the new event RID. Override for deterministic tests. */
  readonly mintEventRid?: (repositoryRid: string) => string;
  /** Set true to fan out callbacks synchronously inside the same call.
   *  Production: false (route returns immediately, dispatcher runs later).
   *  Tests: true (so assertions can read the dispatch outcomes). */
  readonly synchronousDispatch?: boolean;
}

/**
 * Record one ALLOWed ref-update: insert audit + event in a single tx,
 * then optionally kick the dispatcher.
 */
export async function recordPostReceive(
  deps: PostReceiveDeps,
  input: PostReceiveInput,
): Promise<PostReceiveResult> {
  // Use the repository org/namespace to mint a new event RID under the
  // stemma-events service so the rid lives outside the repo's namespace.
  const eventRid =
    deps.mintEventRid?.(input.repositoryRid) ??
    defaultMintEventRid(input.repositoryRid);

  let event!: StemmaEvent;
  let auditRowId!: string;

  await withTx(deps.pool, async (client) => {
    const eventInput: StemmaEventInput = {
      rid: eventRid,
      repositoryRid: input.repositoryRid,
      eventType: input.eventType,
      ref: input.ref,
      oldSha: input.oldSha,
      newSha: input.newSha,
      principalSub: input.principalSub,
      payload: input.payload,
    };
    event = await insertEventWithinTx(client, eventInput);

    const inserted = await insertCodeReposAuditEvent(client, {
      category: "stemma_events",
      action: actionForEventType(input.eventType),
      targetRid: input.repositoryRid,
      targetType: "Repository",
      principalUserId: input.principalUserId,
      principalSource: input.principalSource,
      requestId: input.requestId,
      beforeHash:
        input.oldSha === null
          ? null
          : hashResourceState({ ref: input.ref, sha: input.oldSha }),
      afterHash:
        input.newSha === null
          ? null
          : hashResourceState({ ref: input.ref, sha: input.newSha }),
      sourceIp: input.sourceIp,
      userAgent: input.userAgent,
      parameters: {
        eventRid,
        eventType: input.eventType,
        ref: input.ref,
        oldSha: input.oldSha,
        newSha: input.newSha,
      },
    });
    auditRowId = inserted.auditId;
  });

  // Fan-out runs OUTSIDE the audit tx — by design (B10-C-15). A failing
  // subscriber must not roll back the audit row.
  if (deps.dispatcher) {
    if (deps.synchronousDispatch) {
      const dispatch = await dispatchEvent(deps.dispatcher, event);
      return { event, auditRowId, dispatch };
    }
    // Fire-and-forget — caller doesn't wait. Errors are logged via the
    // dispatcher's metrics; per-subscriber outcomes are recorded on
    // each subscription row. This pattern is identical to the existing
    // `cdcObjectProducer` outbox drain.
    void dispatchEvent(deps.dispatcher, event).catch(() => {
      // Swallow — the dispatcher records every failure on its own.
      // Throwing here would crash the request handler that fired this
      // call.
    });
  }
  return { event, auditRowId };
}

function actionForEventType(t: StemmaEventType): string {
  switch (t) {
    case "PUSH":
      return "stemmaPush";
    case "MERGE":
      return "stemmaMerge";
    case "TAG":
      return "stemmaTag";
    case "PR_OPENED":
      return "prOpened";
    case "PR_MERGED":
      return "prMerged";
    case "PR_CLOSED":
      return "prClosed";
    case "BRANCH_CREATED":
      return "branchCreated";
    case "BRANCH_DELETED":
      return "branchDeleted";
  }
}

function defaultMintEventRid(repositoryRid: string): string {
  // Mint under the STEMMA namespace (events are a Stemma concept),
  // type "event", inheriting the repo's instance so per-tenant
  // discovery uses the same instance slot as the repo. mintRid
  // generates the UUIDv4 component itself.
  //
  // We tolerate parseRid returning null (caller may pass a synthetic
  // RID in tests). In that case we fall back to the default instance.
  const repo = parseRid(repositoryRid);
  return mintRid({
    service: SERVICE_NAMESPACES.STEMMA,
    type: "event",
    instance: repo?.instance,
  });
}

async function withTx<T>(
  pool: Pool,
  fn: (client: import("pg").PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallow */
    }
    throw err;
  } finally {
    client.release();
  }
}
