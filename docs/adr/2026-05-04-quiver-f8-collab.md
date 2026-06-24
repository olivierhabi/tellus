# ADR — Quiver F8: Collab WebSocket Client + Presence

- **Status:** Accepted
- **Date:** 2026-05-04
- **Phase:** 3 (Collab)
- **Task:** T-11 (F8)
- **Upstream deps:** T-10 (B3) DONE

## Context

F8 is the FE collab client and the matching WS gateway. The gateway
closes B3 C-11/12/13 (deferred at B3-time per D-42). The FE client
itself (Redux subscriber, presence avatars, cursor flags, peer
selection borders) lives in tellus-fe per D-23.

## Decision

**Server-side WS gateway** ships in this repo at
`src/services/quiver/ot/wsGateway.ts`. It:

1. Listens for HTTP `upgrade` events on
   `/quiver/api/v1/analyses/{rid}/stream` (regex-matched UUIDv7 RID).
2. Resolves the user via `Sec-WebSocket-Protocol: bearer <jwt>` header
   in production, or `x-test-user` in test mode (when
   `QUIVER_ALLOW_TEST_AUTH=1`). Unresolved → 401 + close (B3 C-12).
3. Subscribes to `collabBus` for the given rid and forwards
   `appliedInstruction`, `serverRebase` (per-recipient), and
   `presenceUpdate` events as JSON.
4. Accepts inbound `presenceUpdate` only (B3 C-13 / F8 C-04
   "outbound durable over HTTP"); echoes them via `emitCollab` so
   peers receive.
5. Tracks the active sessions count gauge and disconnect counter
   metrics; both labels-bounded per G-09.

**FE client** lands in tellus-fe (`/frontend/collab/`):
- `useCollabSocket(rid)` hook: opens WS with `Sec-WebSocket-Protocol`
  header, reconnects with exponential backoff (1 s → 60 s, F8 C-02),
  on reconnect refetches the document and rebases pending instructions.
- Inbound dispatch:
  `appliedInstruction` → OT engine reducer
  `presenceUpdate` → presence slice
  `serverRebase` → `dispatch(showRebaseToast(...))` (F8 C-03)
- Outbound: presence-only via WS; `submitInstructions` over HTTP (F8 C-04).
- `<PresenceAvatars />`: max 8, "+N" overflow, deterministic palette
  hash (F8 C-05).
- `<PeerCursor />`: throttled to 10 Hz, labeled flag (F8 C-06).
- `<PeerSelection />`: colored border on selected card (F8 C-07).
- Reconnect-storm tolerance: 100 simultaneous reconnects in
  `playwright/collab-storm.spec.ts` (F8 C-08).
- 4-headless-browser convergence test (F8 C-09) is the GATE-01 gate.

### What is server-verified now

| C-ID | Where | How |
|---|---|---|
| F8 C-01 | wsGateway + integration test | Connect on `.../stream`, verify open |
| F8 C-03 | integration test | Peer submits over HTTP; wsA receives `appliedInstruction` |
| F8 C-04 | integration test | `submitInstructions` over HTTP; presence over WS |
| B3 C-11 | wsGateway upgrade handler | Path regex on UUIDv7 RID |
| B3 C-12 | integration test | Test auth disabled → 401 on upgrade |
| B3 C-13 | integration test | Peer A sends presence; peer B receives |

### What is FE-only (covered by this ADR per D-24)

| C-ID | Notes |
|---|---|
| F8 C-02 | Auto-reconnect 1s→60s; rebase on reconnect |
| F8 C-05 | Presence avatars max 8; deterministic palette |
| F8 C-06 | Cursor rendering 10 Hz throttle |
| F8 C-07 | Peer selection border |
| F8 C-08 | SLO + reconnect storm — load run at phase boundary (D-17) |
| F8 C-09 | 4-browser Playwright — GATE-01 gate |

## Consequences

- WS auth is currently a placeholder (`bearer <jwt>` shape only,
  no JWT verification). Production must wire Multipass JWT validation
  in `defaultResolveUser`. A D-46 entry tracks this hardening.
- The cursor 10 Hz throttle is enforced FE-side; the gateway forwards
  every presenceUpdate it receives. If a misbehaving client floods the
  bus, the FE peers would over-render. A future server-side rate-limit
  per-user is logged as D-47.
- Reconnect storms (F8 C-08) are bounded by the `ws` library's default
  max-payload + the gateway's per-conn handlers. No per-IP rate limit
  yet — D-48.

## References

- Spec §F8, §B3 C-11..C-13
- Decisions: D-46, D-47, D-48 in
  `decisions/quiver/D-2026-05-04-f8-decisions.md`
- Progress: `tasks/quiver/progress/T-11-F8.md`
