// ---------------------------------------------------------------------------
// Controlled Webhook Test Service (Gap A)
//
// A deterministic, in-repo HTTP server usable from unit, integration, API,
// E2E, and Cypress tests. It removes the external manual dependency the
// previous continuation report flagged: writeback / side-effect webhook
// behavior was unit-tested only because no controlled external system was
// available to receive real HTTP from the production transport.
//
// Design rules (from the completion directive §5):
//   * Configurable endpoints covered by unit/integration/E2E regardless of
//     the caller (writeback vs. side-effect) — the service is path-driven,
//     so a writeback and a side effect target the same deterministic
//     behavior set by choosing a path.
//   * Records a sanitized invocation history: it redacts Authorization,
//     Cookie, X-API-Key, X-Auth-Token, Proxy-Authorization and never
//     stores raw attachment contents or sensitive request values that
//     are not required by the assertion. Sanitization mirrors
//     webhookSafeTransport.redactHeadersForLog.
//   * Provides a reset endpoint so every test begins deterministically.
//   * Runs automatically with the repository's test orchestration — the
//     integration test harness and Cypress orchestration start it; no
//     developer step is required.
//
// The service is deliberately NOT wired into the production server entry —
// it lives under src/services/testing and is only imported by test code
// and the E2E launcher (tests/webhooks/controlledWebhookServer.ts). A
// guarded cli() lets a single long-lived instance bind a fixed port for
// Cypress/E2E (CONTROLLED_WEBHOOK_PORT, default 3329), while unit tests
// bind ephemeral port 0 in-process.
// ---------------------------------------------------------------------------

import http from "http";
import type { AddressInfo } from "net";
import { URL } from "url";

// ---------------------------------------------------------------------------
// Sanitization — never record credentials.
// ---------------------------------------------------------------------------

const REDACT_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
]);

/**
 * Redact credential-bearing headers and shallow-copy the rest. Mirrors
 * webhookSafeTransport.redactHeadersForLog so the recorded history never
 * persists secrets. Also drops raw attachment content: any request body
 * field whose name suggests an attachment payload is stored as
 * "<attachment:NNN bytes redacted>" instead of its bytes.
 */
function sanitizeHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    const lk = k.toLowerCase();
    out[k] = REDACT_HEADERS.has(lk) ? "[REDACTED]" : String(v);
  }
  return out;
}

const ATTACHMENT_HINT =
  /^(content|bytes|data|file|attachment|payload|blob|stream)$/i;

/**
 * Best-effort body sanitization. Arrays and nested records are walked
 * shallowly; attachment-shaped fields are redacted by size hint. Bodies
 * that fail to parse as JSON are kept as a truncated string preview.
 */
function sanitizeBody(raw: string): unknown {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.length > 256 ? `${raw.length}B body` : raw;
  }
  const walk = (val: unknown): unknown => {
    if (val == null) return null;
    if (Array.isArray(val)) return val.map(walk);
    if (typeof val === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        if (ATTACHMENT_HINT.test(k) && (typeof v === "string" || Array.isArray(v))) {
          const n =
            typeof v === "string" ? v.length : (v as unknown[]).length;
          o[k] = `<attachment:${n} bytes redacted>`;
        } else {
          o[k] = walk(v);
        }
      }
      return o;
    }
    return val;
  };
  return walk(parsed);
}

// ---------------------------------------------------------------------------
// Invocation record — what the directive requires the service to record.
// ---------------------------------------------------------------------------

export interface ControlledInvocation {
  seq: number;
  timestamp: number;
  endpoint: string;
  method: string;
  actionOperationId: string | null;
  correlationId: string | null;
  idempotencyKey: string | null;
  requestBody: unknown;
  responseStatus: number;
  responseBodyType: string;
  durationMs: number;
  invocationCount: number;
  duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Behavior catalogue — every deterministic endpoint behavior the directive
// enumerates. A "behavior" is a function that inspects the request and
// returns the { status, contentType, body, delayMs } to send. Behaviors are
// keyed by the request path so writeback and side-effect callers exercise the
// SAME deterministic surface; the distinction is only which controller invokes.
// ---------------------------------------------------------------------------

export type ControlledBehavior =
  | "success" // 2xx JSON
  | "fail" // non-2xx JSON (writeback/side-effect failure)
  | "slow" // configurable delay before responding (200)
  | "timeout" // sleeps past the webhook timeout (no response)
  | "malformed" // 2xx with invalid JSON body
  | "invalid" // 2xx structurally invalid (missing required output)
  | "nested" // 2xx nested typed response
  | "nullable" // 2xx with nullable response values
  | "attachment" // 2xx attachment-compatible response where supported
  | "repeat" // returns the request body N times (side-effect fan-out echo)
  | "duplicate"; // dedupes on X-Idempotency-Key (second call = duplicate status)

export const CONTROLLED_BEHAVIOR_PATHS = [
  "/writeback/success",
  "/writeback/fail",
  "/writeback/slow",
  "/writeback/timeout",
  "/writeback/malformed",
  "/writeback/invalid",
  "/writeback/nested",
  "/writeback/nullable",
  "/writeback/attachment",
  "/sideeffect/success",
  "/sideeffect/fail",
  "/sideeffect/slow",
  "/sideeffect/repeat",
  "/sideeffect/duplicate",
] as const;

function behaviorFor(path: string): ControlledBehavior | null {
  if (path === "/__reset" || path === "/__history") return null;
  for (const p of CONTROLLED_BEHAVIOR_PATHS) {
    if (path === p || path.startsWith(p + "/")) {
      const tail = p.split("/").pop()!;
      return tail as ControlledBehavior;
    }
  }
  return null;
}

interface PendingResponse {
  status: number;
  contentType: string;
  body: string;
  delayMs: number;
  // bodyType label recorded for the invocation, independent of the wire bytes
  // (e.g. malformed records "invalid-json" even though the raw bytes were sent).
  bodyTypeLabel?: string;
}

/**
 * Decide what to send for a behavior. Side effects at /sideeffect/repeat echo
 * the (possibly list) request body N times to exercise fan-out semantics.
 */
function decide(
  behavior: ControlledBehavior,
  req: http.IncomingMessage,
  url: URL,
): PendingResponse {
  const slowMs = Number(url.searchParams.get("ms") ?? "2000");
  // A repeat count overrides repeat echo arity for deterministic fan-out tests.
  const repeatCount = Number(url.searchParams.get("count") ?? "1");
  switch (behavior) {
    case "success":
      return {
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ ok: true, confirmed: true }),
        delayMs: 0,
      };
    case "fail":
      return {
        status: 502,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ error: "external_failed", code: "DOWNSTREAM_REJECTED" }),
        delayMs: 0,
      };
    case "slow":
      return {
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ ok: true, slow: true }),
        delayMs: Number.isFinite(slowMs) ? slowMs : 2000,
      };
    case "timeout":
      // Never respond — caller enforces the timeout. We deliberately do not
      // end the response; the socket will be torn down by the caller's timeout.
      return { status: 0, contentType: "", body: "", delayMs: -1, bodyTypeLabel: "no-response" };
    case "malformed":
      return {
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: "{not-json",
        delayMs: 0,
        bodyTypeLabel: "invalid-json",
      };
    case "invalid":
      return {
        status: 200,
        contentType: "application/json; charset=utf-8",
        // Missing the required `confirmed` output a binding would extract.
        body: JSON.stringify({ ok: true }),
        delayMs: 0,
        bodyTypeLabel: "missing-output",
      };
    case "nested":
      return {
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          result: { record: { code: "AC-1", amount: 12.5, flags: ["a", "b"] } },
        }),
        delayMs: 0,
      };
    case "nullable":
      return {
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ value: null, present: "x" }),
        delayMs: 0,
      };
    case "attachment":
      return {
        status: 200,
        contentType: "application/json; charset=utf-8",
        // attachment-compatible metadata (content redacted at record time)
        body: JSON.stringify({
          attachment: {
            filename: "out.bin",
            size: 4,
            contentType: "application/octet-stream",
          },
        }),
        delayMs: 0,
      };
    case "repeat":
      // We do not know the request body here synchronously; the dispatcher
      // will read the body first and then echo it `repeatCount` times via a
      // sentinel. Instead we record the intent and synthesize in the dispatcher.
      return {
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ ok: true }),
        delayMs: 0,
      };
    case "duplicate":
      // Dedup is handled in the dispatcher using the idempotency key; the
      // first call returns 200 and a confirmation, repeats return 200 with
      // a `duplicate: true` marker (mirrors external dedup acknowledgment).
      return {
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ ok: true, deduplicated: false }),
        delayMs: 0,
      };
  }
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ControlledWebhookServer {
  server: http.Server;
  port: number;
  url: string;
  history: () => ControlledInvocation[];
  reset: () => void;
  close: () => Promise<void>;
}

export function createControlledWebhookServer(opts?: {
  port?: number;
}): ControlledWebhookServer {
  const invocations: ControlledInvocation[] = [];
  const dedupSeen = new Map<string, ControlledInvocation>();
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");

    // Control endpoints
    if (url.pathname === "/__reset") {
      invocations.length = 0;
      dedupSeen.clear();
      seq = 0;
      res.writeHead(200, { "content-type": "application/json" }).end('{"reset":true}');
      return;
    }
    if (url.pathname === "/__history") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(invocations));
      return;
    }

    const behavior = behaviorFor(url.pathname);
    if (!behavior) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"error":"unknown-behavior"}');
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");

    const headerStr = (name: string): string | null => {
      const v = req.headers[name];
      return typeof v === "string" ? v : Array.isArray(v) ? v[0] ?? null : null;
    };
    const idempotencyKey = headerStr("x-idempotency-key");
    const correlationId = headerStr("x-trace-id");
    const actionOperationId = headerStr("x-actor");

    const isDuplicate =
      behavior === "duplicate" &&
      idempotencyKey != null &&
      dedupSeen.has(idempotencyKey);

    const pending = decide(behavior, req, url);

    // /__repeat fan-out: echo the parsed body N times as a list.
    let responseBody = pending.body;
    let responseBodyType = "json";
    if (pending.bodyTypeLabel) responseBodyType = pending.bodyTypeLabel;

    if (behavior === "repeat") {
      let parsed: unknown = null;
      try {
        parsed = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        parsed = null;
      }
      const count = Math.max(1, Number(url.searchParams.get("count") ?? "1") || 1);
      responseBodyType = "json-list";
      // Echo the (single) payload `count` times — this is what a side-effect
      // fan-out function returning a list looks like to the internal mapping.
      // If the caller already passed a list, fan it out across `count` batches.
      const unit = Array.isArray(parsed) ? parsed : [parsed];
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) out.push(unit.length === 1 ? unit[0] : unit);
      responseBody = JSON.stringify(out);
    }

    if (behavior === "duplicate" && isDuplicate) {
      responseBody = JSON.stringify({ ok: true, deduplicated: true });
      responseBodyType = "json-duplicate";
    }

    // Timeout behavior: never respond. Record an invocation with status -1.
    if (pending.delayMs === -1) {
      const rec = record(started, req, url, rawBody, -1, "no-response", idempotencyKey, correlationId, actionOperationId, 0, isDuplicate);
      invocations.push(rec);
      if (behavior === "duplicate" && idempotencyKey != null) dedupSeen.set(idempotencyKey, rec);
      // Intentionally do not end the response; caller times out.
      return;
    }

    if (pending.delayMs > 0) {
      await new Promise((r) => setTimeout(r, pending.delayMs));
    }

    const status = pending.status || 200;
    res.writeHead(status, { "content-type": pending.contentType }).end(responseBody);

    const cnt = invocations.filter((i) => i.endpoint === url.pathname).length + 1;
    const rec = record(
      started,
      req,
      url,
      rawBody,
      status,
      responseBodyType,
      idempotencyKey,
      correlationId,
      actionOperationId,
      cnt,
      isDuplicate,
    );
    invocations.push(rec);
    if (behavior === "duplicate" && idempotencyKey != null) {
      dedupSeen.set(idempotencyKey, rec);
    }
  });

  function record(
    started: number,
    req: http.IncomingMessage,
    url: URL,
    rawBody: string,
    status: number,
    bodyType: string,
    idempotencyKey: string | null,
    correlationId: string | null,
    actionOperationId: string | null,
    invocationCount: number,
    duplicate: boolean,
  ): ControlledInvocation {
    seq += 1;
    return {
      seq,
      timestamp: started,
      endpoint: url.pathname,
      method: req.method ?? "GET",
      actionOperationId,
      correlationId,
      idempotencyKey,
      requestBody: sanitizeBody(rawBody),
      responseStatus: status,
      responseBodyType: bodyType,
      durationMs: Date.now() - started,
      invocationCount,
      duplicate,
    };
  }

  return {
    server,
    get port() {
      return (server.address() as AddressInfo).port;
    },
    get url() {
      return `http://localhost:${(server.address() as AddressInfo).port}`;
    },
    history: () => [...invocations],
    reset: () => {
      invocations.length = 0;
      dedupSeen.clear();
      seq = 0;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// ---------------------------------------------------------------------------
// CLI launcher — started by the E2E/Cypress orchestration as a long-lived
// processes on a fixed port. Lives in the test tree so it is never bundled
// into production. Set CONTROLLED_WEBHOOK_PORT (default 3329).
// ---------------------------------------------------------------------------

export function startControlledWebhookServerCli(
  port = Number(process.env.CONTROLLED_WEBHOOK_PORT ?? 3329),
): Promise<ControlledWebhookServer> {
  return new Promise((resolve, reject) => {
    const svc = createControlledWebhookServer({ port });
    svc.server.on("error", reject);
    svc.server.listen(port, "127.0.0.1", () => {
      console.log(`[controlled-webhook] listening on http://127.0.0.1:${port}`);
      resolve(svc);
    });
  });
}
