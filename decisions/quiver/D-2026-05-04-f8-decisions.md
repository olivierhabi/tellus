# D-entries — Quiver F8 (Collab WebSocket Client + Presence)

## D-46 — JWT verification deferred; placeholder Sec-WebSocket-Protocol parser

**Context.** Spec §B3 C-12 requires "Multipass JWT in
`Sec-WebSocket-Protocol`; expired token → close code 4001."

**Decision.** Ship the gateway with a `defaultResolveUser` that
recognizes the `bearer <jwt>` syntax and returns a placeholder
subject derived from the token's first 16 chars. Test mode (when
`QUIVER_ALLOW_TEST_AUTH=1`) overrides via `x-test-user` header.

**Why.** No JWT verification helper exists in the monorepo today
that can be re-used at the WS layer (the existing
`securityContext` middleware sits inside Express); plumbing it into
the upgrade event would require disentangling Express types from
Node's HTTP types. The placeholder gives a stable surface; tests can
swap `resolveUser` directly.

**Evidence to revisit.** Production must wire real verification
before phase 3 enables in any environment that accepts external
traffic. Track via D-46 follow-up.

## D-47 — No server-side cursor rate-limit in v1

**Context.** F8 C-06 says cursor rendering throttled to 10 Hz;
spec is silent on whether the throttle is FE-only or server-enforced.

**Decision.** FE-only throttle. The gateway forwards every
`presenceUpdate` it receives.

**Why.** Defaulting to a server-side rate limit would risk dropping
legitimate cursor updates from well-behaved clients on a noisy
network; better to push the throttle to the source. If a misbehaving
client floods the bus, peer FEs are still bounded by their own
render-loop throttle.

**Evidence to revisit.** If a single user produces > 100 Hz
presenceUpdate at a sustained rate, add a server-side per-user
token-bucket (~30 Hz cap).

## D-48 — No per-IP reconnect rate limit in v1

**Context.** F8 C-08 specifies tolerance for 100 simultaneous
reconnects.

**Decision.** Tolerance is achieved at the WS library level (no
per-IP limit; the gateway accepts every upgrade that resolves a
user). The 100-storm test will exercise this.

**Why.** A reconnect storm against a single rid is the expected
behavior after a network blip — penalizing clients via 429 would
make recovery slower, not faster.

**Evidence to revisit.** If a runaway tab opens 1000+ WS to the
same rid, add a per-`(userSubject, rid)` cap at 5 connections;
existing connections keep, new ones get 429.
