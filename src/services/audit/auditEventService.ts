// ---------------------------------------------------------------------------
// src/services/audit/auditEventService.ts
//
// Unified audit event service — single surface for both the Action path
// (in-transaction hash-chain append) and the credential-events path
// (standalone durable writes).
//
// Contract (unified, Block B closure for F-P3-11):
//   - Every audit write is durable-before-ack.
//   - Every audit write extends the hash chain (prev_hash, row_hash).
//   - Failures THROW. Callers translate to 503 at the route layer.
//
// The previous contradiction between `auditEventService.ts` (credential
// path, durable-before-ack) and `actionAuditLog.ts` (Action path,
// "must NEVER throw") is RESOLVED: both paths now route through this
// module or directly through the shared hash-chain writer.
// ---------------------------------------------------------------------------

export {
  appendAuditRow,
  logStandaloneFailureAudit,
  logActionExecution,
  AuditDurabilityError,
} from "../../models/actionAuditLog";

export type { AuditLogEntry, AuditResult, FailureType } from "../../models/actionAuditLog";

export {
  insertAuditRowWithHashChain,
  verifyChainSegment,
  AuditHashChainError,
  AUDIT_HASH_CHAIN_LOCK_KEY,
} from "./hashChain";

export type { AuditRowBody, ChainBreak, VerifyReport } from "./hashChain";

export { canonicalJson, canonicalSha256Hex, CanonicalJsonError } from "./canonicalJson";
