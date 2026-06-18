// ---------------------------------------------------------------------------
// B1 — Stemma smart-HTTP route layer.
//
// Wraps the wire codec (pkt-line, advertise-refs, ref-update-command)
// and the storage layer (refStore, repositoryStore, quarantineStore)
// in three Express routes:
//
//   GET  /:rid/info/refs?service=git-(upload|receive)-pack
//        → advertisement, content-type per protocol; B1-C-01, B1-C-02
//   POST /:rid/git-receive-pack
//        → push command parse + CAS + quarantine + audit; B1-C-04
//   POST /:rid/git-upload-pack
//        → 501 Stemma:NotImplemented; D-2026-05-01-006 explicit defer
//
// The route layer applies the §1 globals: auth, IDOR-as-404, audit on
// every accepted push. Idempotency-Key is NOT required on git-receive-
// pack — the receive-pack wire protocol already carries the old-sha
// CAS as its own idempotency mechanism (re-pushing the same commit is
// a no-op at the ref layer).
//
// Tx structure (v1, see D-2026-05-01-006):
//   Tx-1 (separate): create quarantine row in 'pending' state.
//   Tx-2 (inside applyRefUpdates): SERIALIZABLE ref CAS.
//   Tx-3 (separate): set quarantine state, write audit row.
//
// G-C-52 single-tx audit-with-data semantics are deferred — under v1,
// a server crash between Tx-2 and Tx-3 leaves a ref change without an
// audit row (recoverable manually via the quarantine row's pending
// state). A future wave will refactor refStore to expose a within-tx
// variant so all three txs collapse into one.
//
// Spec contracts:
//   B1-C-01  GET /info/refs?service=git-upload-pack — advertise
//   B1-C-02  GET /info/refs?service=git-receive-pack — advertise
//   B1-C-04  POST /git-receive-pack — receive
//   B1-C-23  packfile sha256 fingerprint persisted
//   B1-C-24  per-push quarantine row
//   B1-C-32  push body size limit (default 100 MB)
//   B1-C-46  tombstoned repo → 404 Stemma:RepositoryNotFound (G-C-09)
// ---------------------------------------------------------------------------

import { Router, raw as expressRaw, type Response } from "express";
import type { Pool } from "pg";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { isRid } from "../../codeRepos/contracts/rid";
import { buildEnvelope, ERROR_CODES } from "../../codeRepos/contracts/errors";
import { requireCodeReposAuth } from "../../codeRepos/middleware/principal";
import {
  insertCodeReposAuditEvent,
  hashResourceState,
} from "../../codeRepos/audit/auditEvents";

import {
  encodeRefAdvertisement,
  advertiseContentType,
  receivePackResultContentType,
  type AdvertisedService,
  type AdvertisedRef,
} from "../wire/advertiseRefs";
import {
  parseReceivePackRequest,
  RefUpdateParseError,
  type RefUpdateCommand,
} from "../wire/refUpdateCommand";
import { encodeStream, PktLineDecodeError } from "../wire/pktLine";
import {
  createQuarantineEntryWithinTx,
  setQuarantineStateWithinTx,
  fingerprintPackfile,
} from "../wire/quarantineStore";
import { getRepository } from "../storage/repositoryStore";
import {
  applyRefUpdates,
  listRefs,
  type RefUpdate,
  type RefUpdateOutcome,
} from "../storage/refStore";

export interface StemmaSmartHttpDeps {
  readonly pool: Pool;
  /** Maximum push body size in bytes. Default 100 MB. */
  readonly maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 100 * 1024 * 1024;
const AUDIT_CATEGORY = "stemma";
const TARGET_TYPE_REPO = "Repository";

const ALLOWED_SERVICES: ReadonlySet<string> = new Set([
  "git-upload-pack",
  "git-receive-pack",
]);

export function stemmaSmartHttpRouter(deps: StemmaSmartHttpDeps): Router {
  const router = Router();
  const { pool } = deps;
  const maxBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  router.use(requireCodeReposAuth());

  // -------------------------------------------------------------------------
  // GET /:rid/info/refs?service=git-(upload|receive)-pack — B1-C-01, B1-C-02
  // -------------------------------------------------------------------------
  router.get("/:rid/info/refs", async (req, res) => {
    const rid = req.params.rid;
    if (!isRid(rid)) {
      return sendError(res, 404, "Stemma:RepositoryNotFound", ERROR_CODES.NOT_FOUND, {
        rid,
      });
    }
    const service = String(req.query.service ?? "");
    if (!ALLOWED_SERVICES.has(service)) {
      return sendError(res, 400, "Stemma:InvalidService", ERROR_CODES.INVALID_ARGUMENT, {
        field: "service",
        allowed: Array.from(ALLOWED_SERVICES),
      });
    }

    // getRepository() returns null for non-ACTIVE repos by default,
    // collapsing tombstoned + missing into one 404 path (G-C-09).
    const repo = await getRepository(pool, rid);
    if (repo === null) {
      return sendError(res, 404, "Stemma:RepositoryNotFound", ERROR_CODES.NOT_FOUND, {
        rid,
      });
    }

    const refs = (await listRefs(pool, rid)).filter((r) => !r.isSymbolic);
    const advertised: AdvertisedRef[] = refs.map((r) => ({
      name: r.name,
      sha: r.targetSha ?? "0".repeat(40),
    }));

    const body = encodeRefAdvertisement({
      service: service as AdvertisedService,
      refs: advertised,
    });

    res.setHeader("Content-Type", advertiseContentType(service as AdvertisedService));
    res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
    res.status(200).send(body);
  });

  // -------------------------------------------------------------------------
  // POST /:rid/git-receive-pack — B1-C-04 (control half)
  // -------------------------------------------------------------------------
  router.post(
    "/:rid/git-receive-pack",
    expressRaw({
      type: () => true, // accept any content-type
      limit: maxBytes * 2,
    }),
    async (req, res) => {
      const principal = req.codeReposPrincipal;
      if (!principal) {
        return sendError(res, 500, "Stemma:Internal", ERROR_CODES.INTERNAL, {
          message: "principal not bound",
        });
      }

      const rid = req.params.rid;
      if (!isRid(rid)) {
        return sendError(res, 404, "Stemma:RepositoryNotFound", ERROR_CODES.NOT_FOUND, { rid });
      }

      const repo = await getRepository(pool, rid);
      if (repo === null) {
        return sendError(res, 404, "Stemma:RepositoryNotFound", ERROR_CODES.NOT_FOUND, { rid });
      }

      const body = req.body as Buffer | undefined;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return sendError(res, 400, "Stemma:InvalidArgument", ERROR_CODES.INVALID_ARGUMENT, {
          message: "request body must be a non-empty receive-pack stream",
        });
      }
      if (body.length > maxBytes) {
        return sendError(res, 413, "Stemma:PushBodyTooLarge", ERROR_CODES.INVALID_ARGUMENT, {
          maxBytes,
          actualBytes: body.length,
        });
      }

      let parsed: ReturnType<typeof parseReceivePackRequest>;
      try {
        parsed = parseReceivePackRequest(body);
      } catch (err) {
        if (err instanceof RefUpdateParseError || err instanceof PktLineDecodeError) {
          return sendError(res, 400, "Stemma:InvalidArgument", ERROR_CODES.INVALID_ARGUMENT, {
            parseError: err.code,
            message: err.message,
          });
        }
        throw err;
      }

      const requestId = (req.header("X-Request-Id") as string) || randomUUID();

      // ----- Tx-1: write quarantine row in 'OPEN' state. -----
      const quarClient = await pool.connect();
      let quarantineId: string;
      const quarantineSha: string = fingerprintPackfile(parsed.packfileBody);
      try {
        await quarClient.query("BEGIN");
        const q = await createQuarantineEntryWithinTx(quarClient, {
          repositoryRid: rid,
          principalUserId: principal.userId,
        });
        quarantineId = q.id;
        await quarClient.query("COMMIT");
      } catch (err) {
        try {
          await quarClient.query("ROLLBACK");
        } catch {
          /* swallow */
        }
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(res, 500, "Stemma:Internal", ERROR_CODES.INTERNAL, {
          phase: "quarantine",
          reason: msg,
        });
      } finally {
        quarClient.release();
      }

      // ----- Tx-2: ref CAS via the existing storage layer (SERIALIZABLE). -----
      const updates: RefUpdate[] = parsed.commands.map(commandToRefUpdate);
      let outcome: RefUpdateOutcome;
      try {
        outcome = await applyRefUpdates(pool, rid, updates);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Attempt to mark the quarantine as rejected, best-effort.
        await markQuarantineState(pool, quarantineId, "rejected");
        return sendError(res, 500, "Stemma:Internal", ERROR_CODES.INTERNAL, {
          phase: "ref-cas",
          reason: msg,
        });
      }

      // ----- Tx-3: quarantine state transition + audit. -----
      const auditClient = await pool.connect();
      try {
        await auditClient.query("BEGIN");
        if (outcome.kind === "rejected") {
          await setQuarantineStateWithinTx(auditClient, quarantineId, "rejected");
          await insertCodeReposAuditEvent(auditClient, {
            category: AUDIT_CATEGORY,
            action: "stemmaPushRejected",
            targetRid: rid,
            targetType: TARGET_TYPE_REPO,
            principalUserId: principal.userId,
            principalSource:
              principal.source === "test" ? "system" : principal.source,
            requestId,
            beforeHash: hashResourceState({
              refs: parsed.commands.map((c) => c.refName),
            }),
            afterHash: null,
            sourceIp: principal.sourceIp,
            userAgent: principal.userAgent,
            parameters: {
              quarantineId,
              packfileSha256: quarantineSha,
              rejection: outcome.rejection.reason,
              ref: outcome.rejection.name,
              currentTip: outcome.rejection.currentTip,
            },
          });
        } else {
          await setQuarantineStateWithinTx(auditClient, quarantineId, "accepted");
          await insertCodeReposAuditEvent(auditClient, {
            category: AUDIT_CATEGORY,
            action: "stemmaPushAccepted",
            targetRid: rid,
            targetType: TARGET_TYPE_REPO,
            principalUserId: principal.userId,
            principalSource:
              principal.source === "test" ? "system" : principal.source,
            requestId,
            beforeHash: hashResourceState({
              refs: parsed.commands.map((c) => ({ name: c.refName, sha: c.oldSha })),
            }),
            afterHash: hashResourceState({
              refs: parsed.commands.map((c) => ({ name: c.refName, sha: c.newSha })),
            }),
            sourceIp: principal.sourceIp,
            userAgent: principal.userAgent,
            parameters: {
              quarantineId,
              commandCount: parsed.commands.length,
              packfileBytes: parsed.packfileBody.length,
              packfileSha256: quarantineSha,
            },
          });
        }
        await auditClient.query("COMMIT");
      } catch (err) {
        try {
          await auditClient.query("ROLLBACK");
        } catch {
          /* swallow */
        }
        const msg = err instanceof Error ? err.message : String(err);
        return sendError(res, 500, "Stemma:Internal", ERROR_CODES.INTERNAL, {
          phase: "audit",
          reason: msg,
        });
      } finally {
        auditClient.release();
      }

      return sendReceivePackReport(res, parsed.commands, outcome);
    },
  );

  // -------------------------------------------------------------------------
  // POST /:rid/git-upload-pack — D-2026-05-01-006 explicit defer
  // -------------------------------------------------------------------------
  router.post("/:rid/git-upload-pack", (_req, res) => {
    return sendError(
      res,
      501,
      "Stemma:NotImplemented",
      ERROR_CODES.UNAVAILABLE,
      {
        feature: "git-upload-pack",
        message:
          "git-upload-pack (clone/fetch) is not yet implemented. Tracked under D-2026-05-01-006; see runbook docs/code-repository/B1.md.",
      },
    );
  });

  return router;
}

function commandToRefUpdate(c: RefUpdateCommand): RefUpdate {
  if (c.kind === "create") {
    return { kind: "create", name: c.refName, newSha: c.newSha };
  }
  if (c.kind === "delete") {
    return { kind: "delete", name: c.refName, oldSha: c.oldSha };
  }
  return {
    kind: "update",
    name: c.refName,
    oldSha: c.oldSha,
    newSha: c.newSha,
  };
}

async function markQuarantineState(
  pool: Pool,
  id: string,
  state: "accepted" | "rejected",
): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await setQuarantineStateWithinTx(c, id, state);
    await c.query("COMMIT");
  } catch {
    try {
      await c.query("ROLLBACK");
    } catch {
      /* swallow */
    }
  } finally {
    c.release();
  }
}

/**
 * Emit the receive-pack `report-status` response in pkt-line format.
 *
 * Format:
 *   <pktline> unpack ok\n                 -- or unpack <reason>\n on failure
 *   <pktline> ok <ref>\n                  -- per accepted ref
 *   <pktline> ng <ref> <reason>\n         -- per rejected ref
 *   0000
 */
function sendReceivePackReport(
  res: Response,
  commands: readonly RefUpdateCommand[],
  outcome: RefUpdateOutcome,
): void {
  const lines: (Buffer | string)[] = [];
  lines.push("unpack ok\n");

  if (outcome.kind === "ok") {
    for (const cmd of commands) {
      lines.push(`ok ${cmd.refName}\n`);
    }
  } else {
    for (const cmd of commands) {
      if (cmd.refName === outcome.rejection.name) {
        lines.push(`ng ${cmd.refName} ${outcome.rejection.reason}\n`);
      } else {
        // Atomic semantics: when one ref is rejected, the whole batch
        // is rejected by the storage layer (applyRefUpdates is all-or-
        // nothing). Surface that as `ng <ref> atomic-batch-rejected`.
        lines.push(`ng ${cmd.refName} atomic-batch-rejected\n`);
      }
    }
  }

  const body = encodeStream([...lines, { kind: "flush", payload: Buffer.alloc(0) }]);
  res.setHeader("Content-Type", receivePackResultContentType());
  res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
  res.status(200).send(body);
}

function sendError(
  res: Response,
  status: number,
  errorName: string,
  errorCode: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  parameters: Record<string, unknown>,
): void {
  res.status(status).json(
    buildEnvelope({
      errorCode,
      errorName,
      parameters,
    }),
  );
}
