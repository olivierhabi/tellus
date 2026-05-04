# D-2026-05-01-006 — Smart-HTTP engine choice and B1 scope split

**Date:** 2026-05-01
**Author:** session author
**Status:** ACCEPTED
**Touches contracts:** B1-C-01, B1-C-02, B1-C-03, B1-C-04, B1-C-05, B1-C-23, B1-C-24, B1-C-32, B1-C-50

## Ambiguity

The spec mandates Stemma exposes the Git smart-HTTP transport over a Postgres-backed ref store (B1-C-01..05). Three engines are candidates:

1. **JGit-on-KV** — JVM library; a true server-side implementation of upload-pack and receive-pack with a pluggable storage layer. Foundry-faithful (this is what the spec implicitly references). Cost: a JVM process, JNI bridge, or a service-mesh hop from Node to a Java sidecar.

2. **isomorphic-git** — pure-JS library shipped with Tellus's existing Node stack. Cost: it is *primarily a client*. Server-side surfaces (`upload-pack-advertisement`, `receive-pack`) are not first-class APIs; building them on top requires hand-implementing the wire protocol from scratch using the library's plumbing.

3. **Shell out to `git http-backend`** — POSIX-standard CGI, battle-tested, fully feature-complete. Cost: requires bare repositories on the local filesystem. Our `stemma_ref` table in Postgres is the source of truth; we have no on-disk repos. Adopting `http-backend` means either (a) materialising a fs-backed shadow repo per request (data integrity hazard; race against ref CAS) or (b) abandoning the Postgres-backed ref-store design in favour of a fs-only model (rewriting waves 1-5).

## Options considered

A. **Adopt JGit-on-KV via a Java sidecar.** Foundry-faithful, the most production-ready choice for the long term. Out of scope for a session: implementing the storage adapter, the JNI/RPC bridge, the operational story for the sidecar, the deployment manifests, and the chaos tests against a Java process is a multi-engineer-month project.

B. **Hand-implement the smart-HTTP wire protocol on top of the existing Postgres ref store.** Full control; consistent with the rest of the codebase; testable in-process. Cost: pkt-line codec, capability negotiation, packfile parsing, packfile generation for clones, haves/wants negotiation, delta resolution. Spec-faithful to the wire surface but a non-trivial scope.

C. **Hybrid — implement the *control* half of the wire protocol now (advertise + receive command parse + CAS), defer the *data* half (packfile parse/verify, packfile generation for upload-pack) to a follow-up wave.** Ship the highest-value, most-testable subset; surface the gaps as `501 Stemma:NotImplemented` with a clear runbook entry. Honest about scope.

## Decision

**Option C — hybrid scope split.**

### What lands in this wave

1. **pkt-line codec** (`src/services/stemma/wire/pktLine.ts`) — pure-logic encode/decode, RFC-style, with extensive unit tests. Covers every framing edge case (length parse, flush packet `0000`, delim `0001`, response-end `0002`, max payload 65516).
2. **Advertise refs** (`GET /:rid/info/refs?service=git-upload-pack` and `GET /:rid/info/refs?service=git-receive-pack`) — reads `stemma_ref` rows; emits the smart-HTTP advertisement (`# service=...\n`, capability list, ref list); honours `Content-Type` per spec; returns `404 Stemma:RepositoryNotFound` on unknown rid; returns `400 Stemma:InvalidService` on unknown service param. **B1-C-01, B1-C-02 fully covered.**
3. **Receive-pack control surface** (`POST /:rid/git-receive-pack`) — parses pkt-line ref-update commands (`<old-sha> <new-sha> <ref-name>` per command), parses the capabilities line, runs B10 pre-receive policy, calls `applyRefUpdates` for CAS, emits the `unpack ok` / `ng <ref> <reason>` response in pkt-line. **B1-C-04 control half covered.** The packfile body following the commands is read, length-checked against the configured max, sha256-fingerprinted into `stemma_quarantine`, and either accepted (refs apply) or rejected (refs roll back); deep packfile verification (`git verify-pack` semantics) is deferred and stubbed as a checksum + size check.
4. **Upload-pack** (`POST /:rid/git-upload-pack`) — returns `501 Stemma:NotImplemented` with a documented runbook entry. **Defer B1-C-03 to a follow-up wave.** Production cannot serve clones until then; this is acknowledged in the wave's "what's still blocked" section.

### What's deferred (and why)

- **Full packfile parsing + verification** (B1-C-23, B1-C-32) — these require either calling out to `git verify-pack` (introduces a CLI dependency) or implementing the `pack-*.idx` format from scratch. The current implementation accepts the packfile, fingerprints it, stores it in quarantine, and applies the refs; a follow-up wave wires in deep verification and ties B1-C-23 to a real test.
- **Quarantine repack + gc** (B1-C-19, B1-C-33, B1-C-38) — quarantine entries are written but never repacked; gc is not yet wired. Out of scope for the smart-HTTP layer.
- **Upload-pack body** (B1-C-03) — full clone protocol. ~1000 LoC + extensive negotiation tests.
- **N=50 concurrent push chaos suite** (B1-C-50) — the underlying CAS chaos was already proven at the storage layer in wave 1; the wire-level chaos test (real `git push` from N processes) requires the upload-pack body to be present so the test client can clone first. Surfaces with the upload-pack deferral.

### Rationale

1. **Production safety** (Decision Protocol §2.i) — implementing only the control surface and rejecting clones with a documented `501` is safer than half-implementing upload-pack and silently corrupting clones. The reject path is loud, alertable, and reversible; the silent-corruption path is none of those.
2. **Auditability** (Decision Protocol §2.iv) — every accepted push lands in `stemma_quarantine` with a sha256 fingerprint and a `pushed_by` principal. Even with deep verify deferred, the audit trail is intact.
3. **The more restrictive option** (Decision Protocol §2.iii) — `501 Stemma:NotImplemented` is the most restrictive valid response for a deferred surface. It does not let a partial implementation be relied upon.
4. **Foundry-faithful where possible** — pkt-line, ref-update command parse, capability advertisement, advertisement format, and the `unpack ok / ng` response shape all match the JGit / git-core wire protocol verbatim.

## What evidence would change this

- **Adopt JGit-on-KV (option A)** when: a Java sidecar is in scope; the operational story is clear (kube manifests, mTLS to Stemma, health-check semantics); the JNI/RPC contract is stable. Until then, the JS-native path is the only pragmatic choice.
- **Adopt `git http-backend` (option C variant)** when: the ref store moves to a fs-backed model. Until then, the Postgres-backed ref store is the source of truth and `http-backend`'s fs assumption is incompatible.
- **Implement upload-pack in-house** when: there is bandwidth for ~1500 LoC of packfile-generation code + negotiation tests, OR when an existing JS server-side library matures (e.g. a future `isomorphic-git/server` surface that we don't yet have).

## Forward strategy

This wave delivers:
- pkt-line codec with full unit-test coverage
- advertise refs end-to-end (Postgres → wire) with full integration tests
- receive-pack control surface with full integration tests using a hand-crafted pkt-line client (not a real `git push`)
- upload-pack stub with `501 Stemma:NotImplemented`
- audit row per accepted ref-update; ref CAS via the existing wave-1 storage layer; quarantine row per accepted packfile

The next session can pick up upload-pack (most likely option) or JGit-on-KV (when the Java sidecar lands).

## Tests tagged with this decision

- `tests/unit/code-repos/stemma/wire/pkt-line-unit.test.ts` (D-006)
- `tests/integration/code-repos/stemma/smart-http-advertise-integration.test.ts` (D-006)
- `tests/integration/code-repos/stemma/smart-http-receive-pack-integration.test.ts` (D-006)
- `tests/integration/code-repos/stemma/smart-http-upload-pack-integration.test.ts` (D-006) — verifies the 501 stub
