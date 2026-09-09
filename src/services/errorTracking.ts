// ---------------------------------------------------------------------------
// Error-tracking sink (Sentry-compatible) for server-side failures.
//
// Gated behind SENTRY_DSN: when unset the sink is a HARD NO-OP (no SDK
// import, no network, no log spam) so local dev / test lanes behave exactly
// as before. When set, 5xx-class failures are forwarded to the tracker;
// 4xx client errors are deliberately NOT reported (they are caller bugs,
// not service failures).
//
// The Sentry SDK (@sentry/node) is an OPTIONAL peer: it is dynamically
// required only on the enabled path. If SENTRY_DSN is set but the SDK is
// not installed, the sink degrades to the structured logger with a
// once-per-process warning instead of throwing.
// ---------------------------------------------------------------------------

import { logger } from "../utils/logger";

export interface ErrorTrackingContext {
  /** HTTP status the error maps to (drives the 5xx-only forward policy). */
  statusCode?: number;
  /** Stable machine code (e.g. INTERNAL_ERROR, OBJECT_DATABASE_UNAVAILABLE). */
  errorCode?: string;
  /** Correlation id stamped on the wire response. */
  requestId?: string;
  /** Route path when known (never includes query strings or bodies). */
  route?: string;
}

type SentryLike = {
  captureException: (err: unknown, ctx?: { extra?: Record<string, unknown> }) => void;
};

let sentry: SentryLike | null = null;
let misconfigurationWarned = false;

/** True only when an error-tracking backend is configured. Read at call
 * time (not module load) so tests can toggle SENTRY_DSN per case. */
export function isErrorTrackingEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

function loadSentry(): SentryLike | null {
  if (sentry) return sentry;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@sentry/node") as {
      init?: (opts: { dsn: string }) => void;
      captureException?: SentryLike["captureException"];
    };
    if (typeof mod.captureException !== "function") return null;
    mod.init?.({ dsn: process.env.SENTRY_DSN as string });
    sentry = { captureException: mod.captureException.bind(mod) };
    return sentry;
  } catch {
    if (!misconfigurationWarned) {
      misconfigurationWarned = true;
      logger.warn(
        { backend: "sentry" },
        "SENTRY_DSN is set but @sentry/node is not installed — error tracking falls back to structured logs",
      );
    }
    return null;
  }
}

/**
 * Report a server-side failure. No-op unless SENTRY_DSN is set AND the
 * failure is 5xx-class. Never throws — tracking must not break responses.
 */
export function captureError(err: unknown, ctx: ErrorTrackingContext = {}): void {
  if (!isErrorTrackingEnabled()) return;
  const status = ctx.statusCode ?? 500;
  if (status < 500) return; // client errors are not service failures
  const tracker = loadSentry();
  if (!tracker) {
    logger.error(
      {
        errorCode: ctx.errorCode ?? "INTERNAL_ERROR",
        statusCode: status,
        requestId: ctx.requestId,
        route: ctx.route,
        errorMessage: err instanceof Error ? err.message : String(err),
      },
      "server error (no tracking SDK — structured-log fallback)",
    );
    return;
  }
  try {
    tracker.captureException(err, {
      extra: {
        errorCode: ctx.errorCode,
        statusCode: status,
        requestId: ctx.requestId,
        route: ctx.route,
      },
    });
  } catch {
    // Tracking is best-effort by design.
  }
}
