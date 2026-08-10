# LATENT — Legacy webhook writeback constructs (but does not actively transmit) a secret-NAME Authorization header; one-line fix

Status: Draft — not filed. Filing-ready (self-contained, repro attached).
Severity: **Low — latent info-leak of a secret *identifier* (not its value); no active leak today.** Re-assessed DOWN 2026-08-07 after inspecting the one real legacy binding (see § Impact).
File: standalone draft, intentionally not under `docs/adr/` and not committed.
Move to a tracker only after owner review.

## Summary

The legacy (ontology-registry) writeback executor constructs the outbound
`Authorization` header as a literal placeholder that embeds the webhook's
**secret reference NAME**, not the secret value:

```
Authorization: Bearer <secret:<kind>/<ref>>
```

e.g. `Authorization: Bearer <secret:tellus_secret/slack-token-v2>`. No real
HTTP API accepts this token, so it can never authenticate anything — it is
purely a **latent** leak vector for the secret's identifier. It is NOT actively
transmitted to any third party today (the one real legacy binding targets an
unreachable reserved domain — see § Impact). The connectivity engine
(`src/services/connectivity/webhooks/executor.ts` → `resolveSourceSecrets` →
`* as vault`) resolves real secrets and is unaffected; this is the legacy path
only. The fix is one line.

## Affected code

File: `src/actions/writebackExecutor.ts`, in `executeWriteback` (the legacy
registry branch), building `rawHeaders`:

```ts
  const rawHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-Idempotency-Key": idempotencyKey,
    "X-Trace-Id": ctx.executionId,
    "X-Actor": ctx.actor,
    // Phase 6 will replace this with a real SecretReference resolver
    // against Tellus's secrets manager; for Phase 4, the webhook's
    // placeholder `authenticationConfig.key` (e.g. "apiToken") is sent
    // as a literal bearing the (mocked) secret name, NOT the secret. The
    // production transport layer (Phase 5 outbox worker) calls the secret
    // resolver to materialise `Bearer <real-token>`.
    Authorization: `Bearer <secret:${webhook.authentication_config?.kind ?? "tellus_secret"}/${(webhook.authentication_config as any)?.ref ?? "?"}>`,
  };
```

The header survives `sanitizeOutboundHeaders` (it is passed through to the
HTTPS request at line ~330: `httpRequest({ ..., headers, ... })`).

## Repro

1. Create a legacy webhook with a real-looking external endpoint + a secret ref:
   `POST /api/v1/ontology/:ont/webhooks`
   `{ name: "ReproLeak", method: "POST", status: "active", inputSchema: {type:"object"}, authenticationConfig: {kind:"tellus_secret", ref:"my-prod-token"}, endpointConfig: {url: "https://httpbin.org/post"}, timeoutMs: 15000 }`
2. Bind an action type to it and apply it.
3. Inspect httpbin's echoed request body/headers (httpbin `/post` echoes the
   inbound headers): the response JSON will contain
   `"Authorization": "Bearer <secret:tellus_secret/my-prod-token>"` in the
   echoed headers. The string `my-prod-token` (the secret's NAME) is now in
   httpbin's (and any intermediary's) logs.

(Do NOT run this against a real secret-name in any non-sandbox environment.)

## Impact assessment (corrected from the ADR draft)

**No active leak today.** The one real production legacy binding is
`wbActionGood → NotifySlackR3` (verified 2026-08-07 via
`GET /api/v1/ontology/ri.ontology.main.ontology.…-0001/webhooks/NotifySlackR3`):

```
name = NotifySlackR3   version = 2   status = active   method = POST
endpoint_config   = { "url": "https://example.invalid", "followRedirects": false }
authentication_config = { "ref": "slack-token-v2", "kind": "tellus_secret" }
inputSchema      = { type: object, required: [message], properties: { message: {type: string} } }
```

`endpoint_config.url` is `https://example.invalid` — the boot default
(`webhooks.ts` create defaults `endpointConfig` to `{ url: "https://example.invalid" }`
when the caller omits it; NotifySlackR3 was authored without a real target).
`example.invalid` is an RFC 2606 reserved name that does not resolve to a
reachable endpoint, so the outbound request fails at DNS/connect time
(`DNS_RESOLUTION_FAILED` / connection refused) BEFORE the constructed header
is transmitted over the wire. The literal `Bearer <secret:tellus_secret/slack-token-v2>`
is therefore never sent to any third party today.

So:
- Secret VALUE: never sent (the placeholder format is not a value lookup).
- Secret NAME (`slack-token-v2`): constructed in-process, but not transmitted
  because the target is unreachable. If anyone re-points NotifySlackR3's
  `endpoint_config.url` at a live external host (or creates a new legacy
  webhook with a real URL), the secret name would start leaking to that host
  and its logs on every apply. **Latent, not active.**
- Severity: Low (latent info-leak of a secret identifier, not its value; no
  production endpoint currently receives it). Re-assessed from the "ships an
  auth header that is either useless or a leak" framing in
  `docs/adr/2026-08-07-deprecate-legacy-webhook-registry.md` — that ADR
  overstates the active risk; this ticket is the precise correction.

## Ownership trail ("Phase 6" / secrets resolver)

`grep -rn "Phase 6\|secret resolver\|SecretReference resolver" src/` (date
2026-08-07) shows:

- The ONLY reference to a writeback secret resolver is the comment block at
  `writebackExecutor.ts:312-317` itself ("Phase 6 will replace this with a
  real SecretReference resolver… The production transport layer (Phase 5
  outbox worker) calls the secret resolver to materialise
  `Bearer <real-token>`."). There is no `secretResolver.ts`, no dedicated
  roadmap entry, and no "Phase 5 outbox worker" file that calls a resolver for
  the legacy path.
- The other ~25 "Phase 6" hits are unrelated: `notificationProviders.ts`,
  `notificationRecipientFilter.ts`, `actionSideEffectJob.ts`,
  `runWritebackStage.ts:2,7,102,149,364`, `actionExecutor.ts:104,335,389,423`
  are about notifications/inbox/recipient-filter/semantics/CBAC, not about a
  webhook secrets resolver.
- The resolver that DOES exist is the connectivity engine's
  `resolveSourceSecrets` (`src/services/connectivity/webhooks/executor.ts`) →
  `* as vault` (`src/services/connectivity/credentials/vault`). It covers
  connectivity webhooks only; the legacy branch never wired it.

Conclusion: the legacy-writeback secrets resolver is an **unowned aspiration**
referenced by exactly one comment. The realistic owner is whoever owns
`writebackExecutor.ts` / the action-execution contract (the same owner who
would own the legacy-deprecation ADR). Naming the comment so it's findable:
`src/actions/writebackExecutor.ts:312-320` (the `Authorization:` line + the
"Phase 6" comment above it).

## Minimal fix (independent of any deprecation)

Drop the literal `Authorization` header from the legacy branch. Rationale: no
real HTTP API accepts `Bearer <secret:…>`, so removing it cannot break a
working integration, and it stops constructing (and would stop transmitting)
the secret name. Pseudo-diff:

```diff
   const rawHeaders: Record<string, string> = {
     "Content-Type": "application/json",
     "Accept": "application/json",
     "X-Idempotency-Key": idempotencyKey,
     "X-Trace-Id": ctx.executionId,
     "X-Actor": ctx.actor,
-    Authorization: `Bearer <secret:${webhook.authentication_config?.kind ?? "tellus_secret"}/${(webhook.authentication_config as any)?.ref ?? "?"}>`,
   };
```

(Plus deleting the now-stale "Phase 6 will replace this…" comment, OR
replacing it with: "Legacy webhooks send no Authorization header. Authenticated
egress is a connectivity-webhook concern (resolveSourceSecrets); legacy
webhooks are deprecated — see
docs/adr/2026-08-07-deprecate-legacy-webhook-registry.md.")

This is a one-line behavior change to the legacy path only; the connectivity
path is untouched. It does NOT touch `webhooks.ts` validation, the
`webhook_definitions` schema, or the action-type binding contract.

## Alternative (the "proper" fix, larger)

Wire the legacy branch's `authenticationConfig` through the same vault the
connectivity engine uses: if `kind === "tellus_secret"` and `ref` is set,
resolve the secret value and send `Authorization: Bearer <value>`; else send
no Authorization. This stops the leak AND makes legacy auth actually work
until deprecation. Cost: a new vault dependency in `writebackExecutor.ts` and
a tenant/actor context to scope the vault lookup (the legacy executor's
`WritebackExecutionContext` already carries `tenant` + `actor`). Recommended
ONLY if the deprecation timeline slips and legacy webhooks must keep working
with real auth in the interim; otherwise the minimal fix (drop the header) +
the deprecation is cleaner.

## Verification

- `playwright/data-connection/webhook-action-enablement.spec.ts` covers the
  legacy apply path's egress (the live/stuck tests bind a connectivity webhook
  post-step-3, so they do NOT exercise the legacy Authorization construction).
  After the minimal fix, add a focused unit test on `executeWriteback`'s
  legacy branch asserting the outgoing `httpRequest` headers contain NO
  `authorization` key regardless of `webhook.authentication_config`.
- Manual: the httpbin repro in § Repro should echo headers with no
  `Authorization` entry post-fix.

## Related

- ADR (draft, not committed): `docs/adr/2026-08-07-deprecate-legacy-webhook-registry.md`
  — retiring the legacy path removes this class of issue permanently.
- The connectivity engine's real resolver:
  `src/services/connectivity/webhooks/executor.ts` `resolveSourceSecrets` →
  `src/services/connectivity/credentials/vault`.
