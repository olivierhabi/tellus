# Audit Contract — Tellus Ontology Platform

**Status:** Block B closure for F-P3-11. Authoritative source of truth for the audit subsystem's correctness and regulatory-compliance obligations.

**Regulatory anchor:** Rwandan Law No. 058/2021 on Data Protection, Article 29 (logging of processing activities). Every data-plane read and write of taxpayer data generates an audit record that is **durable before ack** to the client and **tamper-evident** via the forward-walk hash chain.

---

## 1. Scope

Every one of the following operations MUST produce exactly one audit row:

| Category | Events |
|---|---|
| **Action writes** | `POST /api/v1/actionTypes/:apiName/apply`, `applyBatch`, any edit reaching `applyEdits` |
| **Branch ops** | `POST /api/v1/branches`, `/branches/:id/merge`, `/branches/:id/delete` |
| **Object reads** | `GET /api/v1/ontology/:ontologyId/objects/:type/:pk`, `POST /.../search`, `POST /.../searchAround`, `/traverse` |
| **Link ops** | `POST /.../links`, `DELETE /.../links/:type/:src/:tgt`, link-pagination read paths |
| **Auth events** | login, logout, password change, WebAuthn enrollment/deletion, MFA toggle, PAT create/revoke |
| **Admin** | user create/update/delete, role binding change, ontology admin ops |

Operations that do NOT produce an audit row:
- Infrastructure: `/health`, `/api/v1/ready`, `/api/metrics`, `/openapi.json`.
- Internal bookkeeping: migration runner output, audit-verifier checkpoints.

---

## 2. Durability Contract — F-P3-11 Unification

**POLICY (binding, Block B):** Audit rows MUST be durable-before-ack on every Action and Branch path. The previous `must NEVER throw` contract in `src/models/actionAuditLog.ts` is REVOKED.

### 2.1 Write path for Actions

```
BEGIN;                                               -- applyEdits
  INSERT INTO ontology_edit (...);                   -- Action edits
  INSERT INTO link_edit (...);
  ... B1 overlay writes ...
  SELECT pg_advisory_xact_lock(AUDIT_HASH_CHAIN_LOCK_KEY);
  SELECT FOR UPDATE on audit_hash_head WHERE id=1;
  INSERT INTO action_audit_log (..., prev_hash, row_hash);
  UPDATE audit_hash_head SET head_hash=...;
COMMIT;                                              -- atomic edits+audit
```

If ANY step throws, the whole transaction rolls back. The client sees:
- Business failure (validation, OCC conflict, etc.) → `OntologyError` with its own 4xx code.
- Audit failure (head row missing, PG stall) → `AUDIT_DURABILITY_FAILED` 503 with `Retry-After: 5`.

Counter: `tellus_action_audit_rollback_total{reason=hash_chain|standalone}`.

### 2.2 Write path for pre-apply validation failures

Stage 1–5 failures (parameter validation, permission denied, etc.) never reach `applyEdits`, so they take the **standalone** path:

```
const client = getClient();
BEGIN;
  INSERT failure audit row with hash chain;
COMMIT;
```

Failure here throws `AuditDurabilityError` → 503. The audit write is the contract, not a best-effort side-effect.

### 2.3 Read audit

Read-audit rows are generated via the `readAuditMiddleware` (`src/middleware/readAudit.ts`) and enqueued through a transactional outbox (Block H deliverable). Until the outbox lands, read-audit uses the same standalone durable path — acceptable because read volume at SLO (200 r/s) × audit insert latency (~1 ms) = 20% of a single PG connection's capacity, well within the 20-slot pool. Once the outbox ships, read-audit becomes async with bounded lag.

---

## 3. Tamper-Evidence — Hash Chain

### 3.1 Row hash

```
row_hash = sha256(prev_hash || "\n" || canonicalJson(row_body))
```

Where:
- `prev_hash` is the `head_hash` in `audit_hash_head` at the moment of insert.
- `canonicalJson` is the deterministic serializer defined in `src/services/audit/canonicalJson.ts` — keys sorted lexicographically at every level; numbers in shortest round-trip; `-0` normalized to `0`; `undefined`/`NaN`/`Infinity`/`Date`/`BigInt`/`Symbol` rejected; circular refs detected; max depth 64.
- `row_body` is the `AuditRowBody` interface (see `hashChain.ts`) — all audit columns EXCEPT `prev_hash`, `row_hash`, and any row-generated timestamp.

The `\n` separator prevents length-extension ambiguity between `prev_hash` and `canonicalJson(row_body)`.

### 3.2 Genesis anchor

The chain is seeded at migration 036 with a synthetic genesis row:
- `audit_id = 00000000-0000-0000-0000-000000000000`
- `prev_hash = NULL`
- `row_hash = sha256("tellus-audit-genesis-v1")`

This lets the forward-walk verifier treat the chain as non-empty before the first real Action.

### 3.3 Concurrent-writer protocol

Concurrent writers would otherwise fork the chain. To prevent this, every writer:

1. Acquires `pg_advisory_xact_lock(AUDIT_HASH_CHAIN_LOCK_KEY)` — released at txn end.
2. `SELECT head_hash FROM audit_hash_head WHERE id=1 FOR UPDATE` — row lock as belt-and-braces.
3. Computes `prev_hash` and `row_hash`.
4. INSERTs the audit row.
5. UPDATEs the singleton head pointer.

`AUDIT_HASH_CHAIN_LOCK_KEY = 1048899857` (derived from `hashtext('tellus.audit.hash_head')`). Defined as a bigint constant in `src/services/audit/hashChain.ts`.

### 3.4 Forward-walk verifier

`src/jobs/auditVerifier.ts` runs daily:
1. Reads `audit_verifier_checkpoint` (singleton) → cursor.
2. Walks audit rows in `(executed_at ASC, audit_id ASC)` order from cursor.
3. For each row, recomputes `row_hash` and compares against stored value; checks `prev_hash` linkage.
4. On clean: advances checkpoint, sets `tellus_audit_chain_verified_at` gauge to `now()` unix seconds.
5. On break: stops, logs `[audit-verifier] CHAIN BREAK audit_id=... reason=...`, increments `tellus_audit_chain_breaks_total{segment}`, leaves checkpoint at last-clean position.

Break reasons:
- `row_hash_mismatch` — a row's stored `row_hash` does not match recomputed hash (someone edited the row body after commit).
- `prev_hash_mismatch` — a row's `prev_hash` does not equal the previous row's `row_hash` (someone inserted/deleted a middle row).
- `null_hash` — a row has NULL `row_hash` (pre-036 row not yet backfilled, or deliberate corruption).

### 3.5 External WORM anchor — DEFERRED to Appendix J

The daily verifier runs INSIDE the Tellus DB. An attacker with full DB access can silently recompute all hashes. The external anchor closes that gap: the daily verifier signs `head_hash + timestamp` with a KMS key and writes the signature to an S3 Object-Lock bucket owned by a separate account. A daily side-channel verifier (not in this repo) downloads the WORM signatures and cross-checks.

This is documented as a Block D / Appendix J deliverable. The in-DB verifier provides operational tamper-detection under the insider-threat-excluding model; the external anchor closes the insider-with-DB-access model.

---

## 4. Canonical JSON Specification

See `src/services/audit/canonicalJson.ts` for the authoritative spec. Summary:

- **Objects:** keys sorted by UTF-16 code unit order (`Array.prototype.sort()`'s default). Nested objects recursed. `undefined` properties elided (matches `JSON.stringify` elision).
- **Arrays:** elements preserved in source order.
- **Strings:** `JSON.stringify` encoding.
- **Numbers:** `Number.prototype.toString` (shortest round-trip for floats, canonical decimal for integers). `-0` → `"0"`. Non-finite → error.
- **Booleans:** `"true"` / `"false"`.
- **null:** `"null"`.
- **Rejected:** `undefined`, `NaN`, `±Infinity`, `Date`, `BigInt`, `Symbol`, `function`, `Map`/`Set`/`Buffer`/other non-plain prototypes, circular refs, depth > 64.

Callers who have dates MUST pass `date.toISOString()` — this makes timezone handling explicit and avoids platform-dependent serialization.

---

## 5. Operational Runbook

### 5.1 Alert: `tellus_audit_chain_breaks_total > 0`

**Severity:** P0 regulatory incident.

**Response:**
1. Page primary on-call within 5 minutes (per Appendix H.1).
2. Locate the break from logs (`[audit-verifier] CHAIN BREAK`).
3. Identify the break's `audit_id` and `executed_at`.
4. DO NOT auto-repair. The break IS evidence of one of:
   - Deliberate tampering (P0 security incident — engage security team).
   - DB corruption (P0 reliability incident — engage DBA).
   - A bug in the audit writer (P0 code incident — revert the last audit-writer deploy).
5. Preserve a logical PG backup of `action_audit_log` and `audit_hash_head` BEFORE any repair is attempted.
6. Notify the Rwandan DPA of the incident within 72 hours per Law 058/2021 Art. 31 if taxpayer data is implicated.

### 5.2 Alert: `tellus_audit_chain_verified_at` lags > 26 hours

**Severity:** P1.

**Response:** The daily verifier has not completed. Check Temporal / cron scheduler for the verifier job; check PG connection capacity; re-run manually via `node -e "import('./dist/jobs/auditVerifier.js').then(m => m.runAuditVerification())"`.

### 5.3 Alert: `tellus_action_audit_rollback_total{reason=hash_chain} > 0`

**Severity:** P1.

**Response:** Hash-chain append is failing for some Action. Check:
- Is `audit_hash_head` singleton present? (`SELECT * FROM audit_hash_head WHERE id=1`)
- Is `ENFORCE_AUDIT_HASH_CHAIN` set correctly in env?
- Is migration 036 applied?
- Is PG connection pool saturated?

A steady rate of these rollbacks means every affected Action is returning 503 — customer impact is immediate.

---

## 6. Reversibility

`src/migrations/036_audit_hash_chain.down.sql` drops the columns, the head table, the genesis row, and the indices. The down migration is safe to run **only after** redeploying with `ENFORCE_AUDIT_HASH_CHAIN=0`. The runbook is in the down-SQL header.

---

## 7. Unverified / Deferred

- **External WORM anchor** — deferred to Block D / Appendix J.
- **Read-audit transactional outbox** — deferred to Block H (current impl uses standalone durable path; capacity margin verified in §2.3).
- **Migration 037 backfill** — fills `prev_hash`/`row_hash` for pre-036 rows and enforces NOT NULL. Not written in Block B; tracked as T-036B1 in `accepted-risks.md`.
- **Per-row Ed25519 signature** — optional future work; signs individual rows with a KMS key so even DB-level replay cannot forge a row. Documented as Appendix J follow-up.

---

*End of AUDIT_CONTRACT.md.*
