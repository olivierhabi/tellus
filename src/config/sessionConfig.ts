/**
 * src/config/sessionConfig.ts — single source of truth for "how long a
 * user stays logged in."
 *
 * Background
 * ----------
 * Before this module the session window was implied by three hardcoded,
 * mutually-inconsistent numbers spread across the stack:
 *
 *   • TELLUS_TOKEN cookie  Max-Age  16h   (tellusAuthV1.ts)
 *   • TELLUS_REFRESH cookie Max-Age 30d   (tellusAuthV1.ts)
 *   • FE marker cookie / AuthGuard cap 4h (tellus-fe lib/auth.ts)
 *
 * The 4h marker / 16h access-cookie pair is what the edge middleware
 * gates page navigations on. Because they were *shorter* than the 30d
 * refresh cookie, there was a window where a session was still perfectly
 * refreshable but the edge gate had nothing to see — so a freshly opened
 * (or duplicated) tab, which carries no in-memory access token, was
 * bounced to /login before silentRefresh() ever ran. That is the
 * "duplicate a tab and it asks me to log in again" report.
 *
 * The fix is to make ONE env knob drive every layer so they expire
 * together, and to surface that same value to the frontend (see
 * `sessionMaxAgeSeconds` in the /auth responses) so the marker cookie and
 * the AuthGuard forced-logout timer agree with the cookies to the second.
 *
 * Configuration
 * -------------
 *   TELLUS_SESSION_MAX_AGE
 *     Accepts a bare integer (seconds) or a duration suffixed with
 *     s / m / h / d. Examples: `28800`, `8h`, `480m`, `7d`.
 *     Empty or malformed → DEFAULT_SESSION_MAX_AGE_SECONDS (logged once
 *     at boot). Clamped to [MIN, MAX] so a typo can't mint a 1-second or
 *     a 10-year session.
 *
 * Note on the refresh ceiling: the value is capped at 30 days because the
 * Keycloak offline-token (offline_access scope) idle timeout defaults to
 * 30 days — a SESSION_MAX_AGE beyond that would let the cookies outlive
 * the only credential that can refresh them, re-introducing the silent
 * logout this module exists to remove.
 */

/** Default when the env var is unset or malformed: 8 hours. */
export const DEFAULT_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** Floor — a session shorter than a minute is almost certainly a typo. */
export const MIN_SESSION_MAX_AGE_SECONDS = 60;

/** Ceiling — matches the default Keycloak offline-session idle timeout. */
export const MAX_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Default inactivity timeout when TELLUS_SESSION_IDLE_TIMEOUT is unset or
 * malformed: 30 minutes.
 *
 * This is a DIFFERENT axis from the absolute session window above. The
 * session max-age caps how long a login is valid no matter what; the idle
 * timeout signs the user out after a period of NO interaction even if the
 * absolute window still has hours left. The FE's <SessionTimeoutModal />
 * enforces it: after this many seconds of no mouse/keyboard/touch activity
 * it shows a 60-second warning, then calls logout(). We surface the
 * resolved value to the FE as `idleTimeoutSeconds` so the modal honours
 * this single backend knob instead of a hardcoded constant.
 */
export const DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 30 * 60;

/**
 * Floor — an idle timeout shorter than a minute would log an active user
 * out mid-keystroke (the 60s warning countdown alone is already a minute).
 */
export const MIN_SESSION_IDLE_TIMEOUT_SECONDS = 60;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
};

/**
 * Pure parser — turns a raw env string into a positive second count, or
 * returns `fallback` when the input is missing/malformed. Kept pure (no
 * process.env, no clamping) so it is trivially unit-testable.
 */
export function parseDurationSeconds(
  raw: string | undefined,
  fallback: number,
): number {
  if (!raw) return fallback;
  const m = raw.trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d)?$/);
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const unit = m[2] ?? 's';
  return n * UNIT_SECONDS[unit];
}

/**
 * Resolve the configured session window from an env bag — parse, then
 * clamp to [MIN, MAX]. Exposed (taking `env`) so tests can exercise the
 * full resolution without mutating the real process environment.
 */
export function resolveSessionMaxAgeSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = parseDurationSeconds(
    env.TELLUS_SESSION_MAX_AGE,
    DEFAULT_SESSION_MAX_AGE_SECONDS,
  );
  return Math.min(
    Math.max(parsed, MIN_SESSION_MAX_AGE_SECONDS),
    MAX_SESSION_MAX_AGE_SECONDS,
  );
}

/**
 * The resolved session window in seconds, computed once at module load.
 * Every consumer (cookie Max-Age, the `sessionMaxAgeSeconds` echoed to
 * the FE) reads this so they cannot drift apart.
 */
export const SESSION_MAX_AGE_SECONDS = resolveSessionMaxAgeSeconds();

/**
 * Resolve the inactivity timeout from an env bag — parse, clamp to
 * [MIN_IDLE, sessionMaxAge]. The upper bound is the absolute session
 * window itself: an idle timeout longer than the session can ever live is
 * meaningless (the session expires first), so we cap it there rather than
 * at the 30-day session ceiling. Exposed (taking `env`) for the same
 * testability reason as resolveSessionMaxAgeSeconds().
 */
export function resolveSessionIdleTimeoutSeconds(
  env: NodeJS.ProcessEnv = process.env,
  sessionMaxAgeSeconds: number = resolveSessionMaxAgeSeconds(env),
): number {
  const parsed = parseDurationSeconds(
    env.TELLUS_SESSION_IDLE_TIMEOUT,
    DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS,
  );
  return Math.min(
    Math.max(parsed, MIN_SESSION_IDLE_TIMEOUT_SECONDS),
    sessionMaxAgeSeconds,
  );
}

/**
 * The resolved inactivity timeout in seconds, computed once at module
 * load. Echoed to the FE as `idleTimeoutSeconds` so the session-timeout
 * modal honours this single knob.
 */
export const SESSION_IDLE_TIMEOUT_SECONDS = resolveSessionIdleTimeoutSeconds(
  process.env,
  SESSION_MAX_AGE_SECONDS,
);

// One-time boot diagnostics so an operator can confirm the knob took
// effect — and so a fallback/clamp isn't silent.
const rawConfigured = process.env.TELLUS_SESSION_MAX_AGE;
if (rawConfigured && parseDurationSeconds(rawConfigured, -1) === -1) {
  // eslint-disable-next-line no-console
  console.warn(
    `[sessionConfig] TELLUS_SESSION_MAX_AGE="${rawConfigured}" is not a ` +
      `valid duration (use e.g. 8h, 480m, 28800); falling back to ` +
      `${DEFAULT_SESSION_MAX_AGE_SECONDS}s.`,
  );
} else if (
  rawConfigured &&
  parseDurationSeconds(rawConfigured, DEFAULT_SESSION_MAX_AGE_SECONDS) !==
    SESSION_MAX_AGE_SECONDS
) {
  // eslint-disable-next-line no-console
  console.warn(
    `[sessionConfig] TELLUS_SESSION_MAX_AGE clamped to ` +
      `${SESSION_MAX_AGE_SECONDS}s (allowed range ` +
      `${MIN_SESSION_MAX_AGE_SECONDS}–${MAX_SESSION_MAX_AGE_SECONDS}s).`,
  );
}

const rawIdleConfigured = process.env.TELLUS_SESSION_IDLE_TIMEOUT;
if (rawIdleConfigured && parseDurationSeconds(rawIdleConfigured, -1) === -1) {
  // eslint-disable-next-line no-console
  console.warn(
    `[sessionConfig] TELLUS_SESSION_IDLE_TIMEOUT="${rawIdleConfigured}" is ` +
      `not a valid duration (use e.g. 30m, 1800, 1h); falling back to ` +
      `${DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS}s.`,
  );
} else if (
  rawIdleConfigured &&
  parseDurationSeconds(rawIdleConfigured, DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS) !==
    SESSION_IDLE_TIMEOUT_SECONDS
) {
  // eslint-disable-next-line no-console
  console.warn(
    `[sessionConfig] TELLUS_SESSION_IDLE_TIMEOUT clamped to ` +
      `${SESSION_IDLE_TIMEOUT_SECONDS}s (allowed range ` +
      `${MIN_SESSION_IDLE_TIMEOUT_SECONDS}s–session max-age ` +
      `${SESSION_MAX_AGE_SECONDS}s).`,
  );
}
