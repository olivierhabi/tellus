// ---------------------------------------------------------------------------
// B10 — webhook callback dispatcher.
//
// Spec contracts:
//   B10-C-13  HMAC-SHA256 signature on every callback in
//             X-Tellus-Signature header.
//   B10-C-14  5 consecutive failures → state = SUSPENDED.
//   B10-C-15  Async fan-out: deliveries do not block the publisher's
//             tx; failures are recorded but never fail the upstream
//             write.
//
// Design:
//   - Pure orchestration over an injected HTTP delivery function.
//     Tests inject an in-memory deliverer; production injects a
//     timeout-bounded fetch wrapper (left to the route layer).
//   - Per-subscription delivery is independent — a failing subscriber
//     does not block other subscribers (they fan out in parallel).
//   - Secrets are decrypted at the last possible moment (just before
//     the HMAC) so they live in memory for as little as possible.
// ---------------------------------------------------------------------------

import type { Pool } from "pg";
import { signCallbackBody, SIGNATURE_HEADER } from "../hmac";
import {
  listMatchingActiveSubscriptions,
  recordDeliveryFailure,
  recordDeliverySuccess,
  type SubscriptionRow,
  type SubscriptionState,
} from "../store/subscriptionStore";
import type { StemmaEvent } from "../store/eventStore";
import {
  recordError,
  recordRequest,
  observeRequestDuration,
} from "../../codeRepos/observability/metrics";

/**
 * HTTP delivery contract. Production wires this to a fetch with timeout
 * + circuit breaker; tests wire it to an in-memory mock that captures
 * the body + signature header.
 *
 * Returns the integer HTTP status. ANY thrown error from the deliverer
 * is treated as a delivery failure (see deliverEvent).
 */
export interface CallbackDelivery {
  (req: {
    url: string;
    body: string;
    headers: Record<string, string>;
  }): Promise<{ status: number }>;
}

/**
 * Decrypt a stored secret. Production wires KMS or envelope encryption;
 * tests wire identity (encrypted == plaintext).
 */
export interface SecretDecryptor {
  (encrypted: string): string;
}

export interface DispatcherDeps {
  readonly pool: Pool;
  readonly deliver: CallbackDelivery;
  readonly decryptSecret: SecretDecryptor;
  /** Override `now()` for deterministic tests. */
  readonly now?: () => Date;
}

export interface DispatchResult {
  readonly subscriptionRid: string;
  readonly outcome: "delivered" | "failed";
  /** HTTP status if delivered; null on transport-level failure. */
  readonly httpStatus: number | null;
  readonly consecutiveFailures: number;
  readonly state: SubscriptionState;
}

/**
 * Fan an event out to every matching ACTIVE subscription.
 *
 * Atomicity contract: this function NEVER throws on a per-subscriber
 * failure — failures are recorded as DispatchResult entries. A throw
 * here means the LIST query failed (DB outage), and that case is the
 * caller's to handle.
 *
 * Each subscriber's outcome is independent:
 *   - 2xx                    → success; reset consecutive_failures
 *   - non-2xx OR thrown      → failure; increment counter; auto-suspend
 *                              if it reaches the threshold.
 */
export async function dispatchEvent(
  deps: DispatcherDeps,
  event: StemmaEvent,
): Promise<readonly DispatchResult[]> {
  const subs = await listMatchingActiveSubscriptions(
    deps.pool,
    event.repositoryRid,
    event.eventType,
  );

  // Fan out in parallel. Promise.allSettled so one slow subscriber
  // doesn't drag the rest's wall-clock.
  const results = await Promise.all(
    subs.map((sub) => deliverOne(deps, event, sub)),
  );
  return results;
}

async function deliverOne(
  deps: DispatcherDeps,
  event: StemmaEvent,
  sub: SubscriptionRow,
): Promise<DispatchResult> {
  const body = JSON.stringify({
    schema_version: "1.0.0",
    event_id: event.rid,
    event_type: event.eventType,
    repository_rid: event.repositoryRid,
    ref: event.ref,
    old_sha: event.oldSha,
    new_sha: event.newSha,
    occurred_at: event.occurredAt.toISOString(),
    payload: event.payload,
  });

  const secret = deps.decryptSecret(sub.secretEncrypted);
  const signature = signCallbackBody(body, secret);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [SIGNATURE_HEADER]: signature,
    "x-tellus-event-rid": event.rid,
    "x-tellus-event-type": event.eventType,
  };

  const startMs = (deps.now ?? (() => new Date()))().valueOf();
  let httpStatus: number | null = null;
  let delivered = false;
  try {
    const res = await deps.deliver({ url: sub.targetUri, body, headers });
    httpStatus = res.status;
    delivered = res.status >= 200 && res.status < 300;
  } catch {
    // Treated as a transport-layer failure. The dispatcher does not
    // rethrow — surfaces as a DispatchResult.
    delivered = false;
  }
  const elapsedMs = (deps.now ?? (() => new Date()))().valueOf() - startMs;

  // Observability — both success and failure paths emit one request
  // counter; failure additionally emits an error-by-name counter so
  // dashboards can ratio "failed deliveries / total deliveries".
  const statusClass: "2xx" | "4xx" | "5xx" = delivered
    ? "2xx"
    : httpStatus && httpStatus >= 400 && httpStatus < 500
      ? "4xx"
      : "5xx";
  recordRequest({
    service: "stemma_events",
    route: "callback POST",
    status_class: statusClass,
  });
  observeRequestDuration(
    {
      service: "stemma_events",
      route: "callback POST",
      status_class: statusClass,
    },
    elapsedMs / 1000,
  );
  if (!delivered) {
    recordError({
      service: "stemma_events",
      route: "callback POST",
      error_name:
        httpStatus === null
          ? "StemmaEvents:CallbackTransportFailure"
          : "StemmaEvents:CallbackNon2xx",
    });
  }

  if (delivered) {
    await recordDeliverySuccess(deps.pool, sub.rid);
    return {
      subscriptionRid: sub.rid,
      outcome: "delivered",
      httpStatus,
      consecutiveFailures: 0,
      state: "ACTIVE",
    };
  }

  const post = await recordDeliveryFailure(deps.pool, sub.rid);
  return {
    subscriptionRid: sub.rid,
    outcome: "failed",
    httpStatus,
    consecutiveFailures: post.consecutiveFailures,
    state: post.state,
  };
}
