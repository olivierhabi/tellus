# Evidence Policy

Production-readiness audits (#5 evidence hygiene, #6 manifest integrity, #9
incident records) require a clear split between what belongs in Git and what
must never be committed.

## What belongs in Git

Machine-redacted, machine-verifiable records — auditable, immutable history:

- **Incident records** (`.migration-evidence/incidents/*.json`) — structured,
  value-free descriptions of what happened, what was terminated, what was
  reconstructed, and why post-hoc live-row transitions were (im)possible.
- **Migration mappings / completeness ledgers** — e.g.
  `.migration-evidence/funnel-temporal-isolation/*.mapping.json`.
- **Manifests** (`.migration-evidence/MANIFEST.json`) — sha256 + size + mtime
  per committed evidence file, plus the git commit and status they were
  generated against. Regenerate with
  `npx tsx scripts/evidence/build-manifest.ts` whenever evidence changes.
- **Small redacted captures** — dumps whose sensitive VALUES have been
  replaced by typed placeholders (`<redacted:uuid>`, `<redacted:string>`, …)
  while preserving shape (`_redacted: true` marker). See
  `scripts/evidence/redact.ts` / `scripts/evidence/redact-sample.ts`.

## What does NOT belong in Git

VERBATIM runtime dumps: full workflow histories, raw search hits containing
real data-row values, tokens, headers, or any credential material. These
belong in **CI artifacts or dev machines only**.

Store them under the gitignore'd convention directory:

```
.migration-evidence/raw/        # never committed — verbatim dumps only
```

Then land a redacted twin at the normal path and reference it from the
incident record / mapping.

## Commit policy

- **No credentials** — no tokens, headers, keys, connection strings with
  credentials, in any form, even "test-fixture" ones. Redact or remove; the
  scanner allow-lists nothing of this kind. (Only base64 Temporal history
  payload blobs are exempt — they are not JWTs and carry no credential
  semantics.)
- **No production data values** — customer identifiers, row payloads, etc.
  are replaced by typed placeholders before commit.
- Incident records reference evidence files by repo-relative path; the
  validator fails if a referenced file is missing.

## Enforcement

Enforced by the pure-unit lane (file-based only, no PG/Docker):

`tests/unit/evidence/evidenceAudit-unit.test.ts` runs:

1. `scripts/evidence/scan-secrets.ts` over `.migration-evidence/` — any
   credential pattern (JWT shape, `Bearer `, `Authorization:`, passwords,
   cookies, session ids, secrets, API keys, PEM private-key blocks,
   credentialed postgres/mysql URLs, AWS access-key shape) fails the lane.
   The generated `MANIFEST.json` itself is exempt: it contains only digests,
   metadata, and `git status --porcelain` file *paths*, never file contents.
2. `scripts/evidence/build-manifest.ts` against a temp fixture — asserts
   manifest schema and sha256 correctness.
3. `scripts/evidence/validate-incidents.ts` — asserts both incident artifacts
   satisfy the declarative schema and that every referenced evidence file
   exists.
4. `scripts/evidence/redact.ts` idempotency checks on JWT / credentialed PG
   URL / Authorization header / PEM key inputs.

Run the tools manually:

```bash
npx tsx scripts/evidence/scan-secrets.ts           # exit 1 on any finding
npx tsx scripts/evidence/build-manifest.ts         # regenerate MANIFEST.json
npx tsx scripts/evidence/validate-incidents.ts     # exit 1 on any violation
```
