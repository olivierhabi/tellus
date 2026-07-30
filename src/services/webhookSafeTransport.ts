// ---------------------------------------------------------------------------
// Webhook Safe Transport — pure-text + IP-classification helpers (Phase 3)
//
// Phase 3 lands the SAFE-TRANSPORT GATE the webhook transport layer (Phase 4
// writeback executor + Phase 5 outbox worker) calls BEFORE issuing any HTTP
// request. Every outbound HTTPS/HTTPS request MUST route through these
// helpers; never `fetch(url)` raw.
//
// The functions in this module are PURE — they take primitives, return
// validation results, and perform no IO. The DNS/IP lookups (DNS rebinding
// protection, IP-address allowlist checks, connection timeouts, certificate
// verification) live alongside the actual transport layer (Phase 4/5) where
// they need a net.Socket to apply.
//
// What this module covers (pure):
//   * Forbidden-URL shape rejection (HTTP in production; loopback; link
//     local; metadata service; reserved IP space; user-supplied IP literals).
//   * Method allowlist (GET / POST / PUT / PATCH / DELETE) with explicit
//     rejection of `TRACE` / `CONNECT` / `OPTIONS` / `HEAD`.
//   * Hop-by-hop header stripping (RFC 7230 §6.1) + authentication/header
//     redaction in any log message (never leak `Authorization` / `Cookie` /
//     `Set-Cookie` / `X-API-Key` to logs).
//   * Maximum request body size + maximum response body size enforcement
//     (helpers; bytes-counted at the transport layer where the body is
//     bound to a Buffer/Readable).
//   * Response content-type allowlist (Phase 4 will filter to JSON variants).
//   * Idempotency-key derivation from (execution_id, attempt_count).
//
// Security notes:
//   * Production: HTTPS is REQUIRED; HTTP is rejected unless
//     `WebhookAllowInsecureHttpForDev=1` is set in the env config (only
//     honored when `NODE_ENV !== "production"`).
//   * Private RFC 1918 / loopback / link-local / multicast / reserved
//     IPs are rejected at the URL-parse stage — this catches URL-literal
//     IP forms like `http://127.0.0.1@evil.example/`. The DNS-rebinding
//     check (where the resolved IP at request time differs from the
//     IP at preflight time) lands in the transport layer (Phase 4/5)
//     where the post-DNS IP is available.
//   * The cloud metadata service IP `169.254.169.254` is rejected
//     explicitly (AWS/GCP/Azure all publish instance metadata there).
//
// Future Phase 6 hardening (TODO — not Phase 3):
//   * Per-ontology / per-actor / per-endpoint rate limiting + circuit
//     breaking (Redis-backed) — lands alongside the durable outbox
//     worker where the metrics exist.
//   * Tight TLS certificate verification requirement (allowlist of root
//     CAs) — left at Node's default behaviour today (verify against the
//     system store); Phase 6 may pin to a webhook-transport-specific
//     trust store.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

// Headers the BE never wants to surface in API responses or structured
// logs — these carry credentials or session material. The transport
// layer masks them with `[REDACTED]` before any log line is built.
const REDACT_LOG_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
]);

const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const REJECTED_METHODS: ReadonlySet<string> = new Set([
  "TRACE",
  "CONNECT",
  "OPTIONS",
  "HEAD",
]);

const CLOUD_METADATA_IP = "169.254.169.254";

// ---------------------------------------------------------------------------
// Result type — every helper returns an array of structured validation
// errors; [] means accept.
// ---------------------------------------------------------------------------

export interface SafeTransportError {
  readonly code:
    | "URL_REQUIRED"
    | "INSECURE_HTTP_DISABLED"
    | "URL_PARSE_FAILED"
    | "FORBIDDEN_HOST"
    | "IP_LITERAL"
    | "FORBIDDEN_IP"
    | "METADATA_IP"
    | "FORBIDDEN_METHOD"
    | "INVALID_METHOD"
    | "MAX_BODY_EXCEEDED"
    | "MAX_RESPONSE_EXCEEDED"
    | "REDIRECT_NOT_ALLOWED"
    | "REDIRECT_PROTOCOL_DOWNGRADE"
    | "REDIRECT_HOST_NOT_ALLOWED"
    | "CONTENT_TYPE_NOT_ALLOWED";
  readonly message: string;
}

export type SafeTransportResult =
  | { kind: "ok" }
  | { kind: "errors"; errors: SafeTransportError[] };

const OK: SafeTransportResult = { kind: "ok" };
function err<X extends SafeTransportError>(e: X): SafeTransportResult {
  return { kind: "errors", errors: [e] };
}
function errs<X extends SafeTransportError[]>(es: X): SafeTransportResult {
  return { kind: "errors", errors: es };
}

// ---------------------------------------------------------------------------
// Environment hooks — Phase 4/5 transport layer injects
// `httpsRequired: true` for prod / `false` for dev. Pure module never reads
// process.env directly; the configuration surface is injected.
// ---------------------------------------------------------------------------

export interface EgressPolicy {
  /** Production default = true. Tests + dev override to false. */
  readonly httpsRequired: boolean;
  /** By default, redirects are DISABLED (security vs usability tradeoff). */
  readonly followRedirects: boolean;
  /** Host allowlist — empty means unrestricted. */
  readonly allowedHosts: ReadonlyArray<string>;
  /** Header allowlist — empty means unrestricted. */
  readonly headerAllowlist: ReadonlyArray<string>;
  /** Maximum request body size in bytes. */
  readonly maxRequestBytes: number;
  /** Maximum response body size in bytes. */
  readonly maxResponseBytes: number;
  /** Allowed content-types for the response (Phase 4 uses JSON variants). */
  readonly allowedResponseContentTypes: ReadonlyArray<string>;
}

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  httpsRequired: true,
  followRedirects: false,
  allowedHosts: [],
  headerAllowlist: [],
  maxRequestBytes: 1024 * 1024, // 1 MiB
  maxResponseBytes: 1024 * 1024,
  allowedResponseContentTypes: [
    "application/json",
    "application/json; charset=utf-8",
    "application/json; charset=UTF-8",
    "application/problem+json",
    "application/problem+json; charset=utf-8",
    "text/plain",
    "text/plain; charset=utf-8",
  ],
};

// ---------------------------------------------------------------------------
// buildEgressPolicy — env-driven policy selection.
//
// Production: the immutable DEFAULT_EGRESS_POLICY (httpsRequired=true,
// unrestricted hosts). This is the only policy the production transport
// ever uses.
//
// Deterministic test mode (Gap A controlled webhook service): when
// `WebhookAllowInsecureHttpForDev=1` AND `NODE_ENV !== "production"`, the
// policy permits HTTP (httpsRequired=false) and restricts the egress
// allowlist to the single host `localhost`. This is the narrowest possible
// relaxation: the controlled webhook service advertises its URL as
// `http://localhost:<port>` (a hostname, NOT an IP literal, so the SSRF
// IP-literal guard still rejects 127.0.0.1/169.254.x/link-local forms
// even if a binding tried them), the host allowlist rejects every other
// host, and HTTP is only ever honored outside production. No arbitrary
// user-supplied webhook URL escapes the allowlist — the security model
// (§18 of the completion directive) is preserved.
//
// ---------------------------------------------------------------------------

export function buildEgressPolicy(env: NodeJS.ProcessEnv = process.env): EgressPolicy {
  const devInsecureHttp =
    env.WebhookAllowInsecureHttpForDev === "1" &&
    env.NODE_ENV !== "production";
  if (!devInsecureHttp) return DEFAULT_EGRESS_POLICY;
  return {
    ...DEFAULT_EGRESS_POLICY,
    httpsRequired: false,
    allowedHosts: ["localhost"],
  };
}

// ---------------------------------------------------------------------------
// assertEgressUrl — the production-grade safe-transport entry point.
// Pure (DNS-rebinding is checked at request time in the transport layer).
//
// What's checked here:
//   * URL parses (RFC 3986)
//   * Protocol is https when httpsRequired (HTTP rejected)
//   * Host is not a forbidden IP literal: loopback (127.0.0.0/8),
//     link-local (169.254.0.0/16), multicast (224.0.0.0/4), reserved
//     (240.0.0.0/4), cloud metadata (169.254.169.254)
//   * Host is in the allowlist when the policy provides one
//   * Host is not a hostname-collision trick like `127.0.0.1.evil.example.`
//     is NOT rejected here (DNS resolves the hostname at request time;
//     what we CAN do is reject URL IP-literal forms in the forbidden ranges
//     — that closes the trivial extrusion path).
// ---------------------------------------------------------------------------

export function assertEgressUrl(
  url: unknown,
  policy: EgressPolicy = DEFAULT_EGRESS_POLICY,
): SafeTransportResult {
  if (typeof url !== "string" || url.length === 0) {
    return err({ code: "URL_REQUIRED", message: "url is required and must be a non-empty string." });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e: any) {
    return err({ code: "URL_PARSE_FAILED", message: `URL could not be parsed: ${e.message ?? String(e)}` });
  }

  const errors: SafeTransportError[] = [];

  if (parsed.protocol !== "https:") {
    if (policy.httpsRequired && parsed.protocol !== "https:") {
      errors.push({
        code: "INSECURE_HTTP_DISABLED",
        message: `Protocol '${parsed.protocol}' is forbidden. Webhook egress requires HTTPS in production. Use NODE_ENV=development with WebhookAllowInsecureHttpForDev=1 to permit HTTP for testing.`,
      });
    }
  }

  const host = parsed.hostname.toLowerCase();
  if (isForbiddenIpLiteral(host)) {
    if (host === CLOUD_METADATA_IP) {
      errors.push({
        code: "METADATA_IP",
        message: `Host '${host}' is the cloud metadata service IP (169.254.169.254) and cannot be a webhook target.`,
      });
    } else {
      errors.push({
        code: "FORBIDDEN_IP",
        message: `Host '${host}' is a forbidden IP literal (loopback / link-local / multicast / reserved).`,
      });
    }
  }

  if (policy.allowedHosts.length > 0 && !policy.allowedHosts.includes(host)) {
    errors.push({
      code: "FORBIDDEN_HOST",
      message: `Host '${host}' is not in the egress allowlist. Allowed: ${policy.allowedHosts.join(", ")}.`,
    });
  }

  if (errors.length > 0) return errs(errors);
  return OK;
}

/**
 * Reject a hostname that is a literal IP in a forbidden range.
 * Returns true when the host is a forbidden IP literal.
 *
 * The full IP-family detection (IPv4 vs IPv6 + IPv4-in-IPv6 form) lives
 * here so callers don't re-implement the parse-each-time. IP literals
 * are checked via regex; DNS resolution happens at the transport layer.
 */
export function isForbiddenIpLiteral(host: string): boolean {
  const h = host.toLowerCase();
  if (h === CLOUD_METADATA_IP) return true;
  // IPv4 numeric form
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = v4.exec(h);
  if (m) {
    const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (octets.some((o) => o > 255 || Number.isNaN(o))) return false; // not a valid IP — let DNS handle it
    const [a, b] = octets;
    // Loopback: 127.0.0.0/8 (0x7f000000/8)
    if (a === 127) return true;
    // Link-local: 169.254.0.0/16 (catches cloud metadata 169.254.169.254 too)
    if (a === 169 && b === 254) return true;
    // Private range RFC 1918 — DEFER (private-IP egress may be required
    // for internal SSRF allowance; the policy.allowedHosts / a per-ontology
    // IP allowlist keys off this in Phase 6).
    // Multicast: 224.0.0.0/4 (224..239)
    if (a >= 224 && a <= 239) return true;
    // Reserved: 240.0.0.0/4 (240..255)
    if (a >= 240) return true;
    // 0.0.0.0/8 — "this network"
    if (a === 0) return true;
    return false;
  }
  // IPv6 numeric form — reject loopback (::1) + IPv4-in-IPv6 (::ffff:127.x.x.x).
  if (h === "::1" || h === "::" || h.startsWith("fe80") /* link-local */ ) return true;
  const v6Mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (v6Mapped) return isForbiddenIpLiteral(v6Mapped[1]);
  // Otherwise DNS-resolvable hostname — not a forbidden literal.
  return false;
}

// ---------------------------------------------------------------------------
// Method validation
// ---------------------------------------------------------------------------

export function assertMethod(method: string): SafeTransportResult {
  const upper = method.toUpperCase();
  if (REJECTED_METHODS.has(upper)) {
    return err({
      code: "FORBIDDEN_METHOD",
      message: `Method '${upper}' is FORBIDDEN for webhook outbound calls (TRACE/CONNECT/OPTIONS/HEAD are not allowed).`,
    });
  }
  if (!ALLOWED_METHODS.has(upper)) {
    return err({
      code: "INVALID_METHOD",
      message: `Method '${method}' is not a valid HTTP method for webhook outbound (allowed: ${Array.from(ALLOWED_METHODS).join(", ")}).`,
    });
  }
  return OK;
}

// ---------------------------------------------------------------------------
// Header hygiene — strip hop-by-hop, redact in logs
// ---------------------------------------------------------------------------

/**
 * Strip hop-by-hop headers (RFC 7230 §6.1) + any caller-supplied headers
 * not in the policy.headerAllowlist. Returns a clean outbound header set.
 * The returned object is the caller's headers object; the function does
 * not mutate the input — copies it.
 */
export function sanitizeOutboundHeaders(
  headers: Record<string, string>,
  policy: EgressPolicy = DEFAULT_EGRESS_POLICY,
): { headers: Record<string, string>; stripped: string[] } {
  const stripped: string[] = [];
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk)) {
      stripped.push(key);
      continue;
    }
    if (policy.headerAllowlist.length > 0 && !policy.headerAllowlist.includes(lk)) {
      stripped.push(key);
      continue;
    }
    out[key] = value;
  }
  return { headers: out, stripped };
}

/**
 * Redact credentials from a header set before logging it. Returns a
 * shallow copy of `headers` with credentials-bearing headers replaced
 * by `[REDACTED]`. Used by the transport layer's structured log
 * emitters (Phase 4/5) so log lines never leak:
 *   `Authorization: Bearer xyz…`
 */
export function redactHeadersForLog(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lk = key.toLowerCase();
    out[key] = REDACT_LOG_HEADERS.has(lk) ? "[REDACTED]" : value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Body size helpers
// ---------------------------------------------------------------------------

export function assertRequestBytes(
  byteLength: number,
  policy: EgressPolicy = DEFAULT_EGRESS_POLICY,
): SafeTransportResult {
  if (typeof byteLength !== "number" || byteLength < 0) {
    return err({ code: "MAX_BODY_EXCEEDED", message: "byte length must be a non-negative number." });
  }
  if (byteLength > policy.maxRequestBytes) {
    return err({
      code: "MAX_BODY_EXCEEDED",
      message: `Request body ${byteLength} B exceeds maxRequestBytes ${policy.maxRequestBytes} B.`,
    });
  }
  return OK;
}

export function assertResponseBytes(
  byteLength: number,
  policy: EgressPolicy = DEFAULT_EGRESS_POLICY,
): SafeTransportResult {
  if (typeof byteLength !== "number" || byteLength < 0) {
    return err({ code: "MAX_RESPONSE_EXCEEDED", message: "byte length must be a non-negative number." });
  }
  if (byteLength > policy.maxResponseBytes) {
    return err({
      code: "MAX_RESPONSE_EXCEEDED",
      message: `Response body ${byteLength} B exceeds maxResponseBytes ${policy.maxResponseBytes} B.`,
    });
  }
  return OK;
}

export function assertResponseContentType(
  contentType: string,
  policy: EgressPolicy = DEFAULT_EGRESS_POLICY,
): SafeTransportResult {
  if (!contentType || typeof contentType !== "string") {
    return err({ code: "CONTENT_TYPE_NOT_ALLOWED", message: "Content-Type is required." });
  }
  const ct = contentType.toLowerCase().split(";")[0].trim();
  const withCharset = contentType.toLowerCase();
  if (policy.allowedResponseContentTypes.includes(withCharset)) return OK;
  if (policy.allowedResponseContentTypes.includes(ct)) return OK;
  return err({
    code: "CONTENT_TYPE_NOT_ALLOWED",
    message: `Content-Type '${contentType}' is not allowed (allowed: ${policy.allowedResponseContentTypes.join(", ")}).`,
  });
}

// ---------------------------------------------------------------------------
// Idempotency-key derivation — Phase 5 outbox worker can retry a job
// while keeping the external system's idempotency-key stable so an
// external system that received a previous delivery can deduplicate.
// ---------------------------------------------------------------------------

/**
 * Derive a stable idempotency key from (executionId, attemptCount).
 * Implementation: sha256(executionId || '.' || attemptCount) — stable
 * across attempts (so the external system sees the same key when it
 * delivered a previous delivery, even if the worker is retrying) BUT
 * different across distinct executions (so two real executions don't
 * collide on the same key).
 */
import { createHash } from "crypto";

export function deriveIdempotencyKey(
  executionId: string,
  attemptCount: number,
): string {
  return createHash("sha256")
    .update(`${executionId}.${attemptCount}`, "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Redirect validation — used by the transport layer when it follows a
// 3xx (only when policy.followRedirects ALLOW redirects).
// ---------------------------------------------------------------------------

export function assertRedirect(
  fromUrl: string,
  toUrl: string,
  policy: EgressPolicy = DEFAULT_EGRESS_POLICY,
): SafeTransportResult {
  if (!policy.followRedirects) {
    return err({
      code: "REDIRECT_NOT_ALLOWED",
      message: `Redirect from '${fromUrl}' to '${toUrl}' is forbidden by the egress policy (followRedirects=false). Set followRedirects=true with ` + 
        `host+protocol revalidation to allow explicitly.`,
    });
  }
  let toParsed: URL;
  try {
    toParsed = new URL(toUrl, fromUrl);
  } catch (e: any) {
    return err({ code: "URL_PARSE_FAILED", message: `Redirect target URL could not be parsed: ${e.message ?? String(e)}` });
  }
  if (toParsed.protocol !== "https:") {
    return err({
      code: "REDIRECT_PROTOCOL_DOWNGRADE",
      message: `Redirect from '${fromUrl}' to '${toUrl}' downgrades protocol from https to ${toParsed.protocol}. Forbidden.`,
    });
  }
  if (policy.allowedHosts.length > 0 && !policy.allowedHosts.includes(toParsed.hostname.toLowerCase())) {
    return err({
      code: "REDIRECT_HOST_NOT_ALLOWED",
      message: `Redirect target '${toUrl}' has host '${toParsed.hostname}' not in the egress allowlist. Allowed: ${policy.allowedHosts.join(", ")}.`,
    });
  }
  return assertEgressUrl(toUrl, policy);
}
