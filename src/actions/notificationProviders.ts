// ---------------------------------------------------------------------------
// Notification Provider — Phase 5 abstraction replacing mockSendNotification.
//
// The mock sent-notification was a single in-process function with a
// console.log. Phase 5 promotes the surface to a provider abstraction:
//   * `InAppProvider` — write to a per-user inbox table (Phase 6 ships
//     the UI reader; Phase 5 just inserts into `notification_inbox`).
//   * `EmailProvider` — SMTP / external email service. Phase 5 wires
//     a STUB `console.info` provider that formats the email body —
//     operators plug in their own SMTP / SendGrid via env (`EMAIL_PROVIDER_URL`).
//   * `SlackCompatibleProvider` — post to a Slack-compatible webhook
//     endpoint (Typetoken, Discourse, MS Teams adaptive cards) using
//     the existing actionWebhooks transport layer (webhookSafeTransport).
//
// Each provider implements `send(request: NotificationRequest): Promise<NotificationDeliveryResult>`.
// Providers MUST:
//   * Throw on infrastructure failure (network drop, SMTP 5xx) — the
//     worker catches + retries/ dead-letters via the outbox.
//   * Return `{ ok: true, receiptId }` on success.
//   * NEVER log credentials or message bodies unredacted.
//
// Phase 6 will:
//   * Add telemetry + structured logs + tracing spans around each
//     dispatch.
//   * Apply the per-action-type's per-rule authorization checks
//     (recipient data filter — recipient MUST have visibility on every
//     object referenced in the notification content, else the notification
//     is dropped from the dispatch list; the worker records WHY
//     (dropped=insufficient_visibility)).
// ---------------------------------------------------------------------------

import { incCounter } from "../services/funnel/metrics";

// ---------------------------------------------------------------------------
// Request + result — the canonical contract
// ---------------------------------------------------------------------------

export type NotificationChannel = "in_app" | "email" | "slack_compatible";

export interface NotificationRecipient {
  /** Stable principal id (user or group). Phase 5 wires single-user only. */
  principal: string;
  principalKind: "user" | "group";
  /** Phase 6.4 — the resolved `users.id` UUID for the recipient. Populated
   * by the notification recipient data filter at worker-dispatch time when
   * the principal was resolvable via `keycloakAdminService.findUserByEmail`
   * (or the role/group expansion future-work). NULL when the principal
   * wasn't resolvable (in which case the recipient data filter has already
   * dropped the recipient from the dispatch list). */
  userUuid?: string | null;
}

export interface NotificationRequest {
  templateId: string;
  /** Per-template parameters (validated against the template schema at
   * action-type save time). */
  templateParameters: Record<string, unknown>;
  /** Resolved channel (already consulted the template's preferred channel). */
  channel: NotificationChannel;
  /** The recipient (already resolved from the spec's `recipients[]`). */
  recipient: NotificationRecipient;
  /** Execution context for log enrichment. */
  executionId: string;
  actionTypeApiName: string;
  ontologyId: string;
}

export interface NotificationDeliveryResult {
  ok: boolean;
  receiptId?: string;
  /** Optional diagnostic message for the structured log. */
  diagnostic?: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface NotificationProvider {
  channel: NotificationChannel;
  send(request: NotificationRequest): Promise<NotificationDeliveryResult>;
}

// ---------------------------------------------------------------------------
// In-app — Phase 6.4 ships the real per-user inbox table. The InApp
// provider INSERTs one row per delivery via the model layer
// (`models/notificationInbox.ts`); the FE inbox reader consumes
// the `/api/v1/notifications` route.
//
// When `recipient.userUuid` is missing (the recipient filter has not
// resolved to a users.id UUID — the only case the filter ALLOWS through
// today is `affectedObjects=[]`, where there are no markings to gate on)
// the InApp provider logs + counts the failure but doesn't throw (we
// don't want to retry a permanently-unresolvable recipient forever).
// ---------------------------------------------------------------------------

import { insertNotification } from "../models/notificationInbox";

export const inAppNotificationProvider: NotificationProvider = {
  channel: "in_app",
  async send(req): Promise<NotificationDeliveryResult> {
    incCounter("tellus_notification_in_app_total");
    const recipientUuid = req.recipient.userUuid;
    if (!recipientUuid) {
      // The recipient data filter is the canonical resolver; if the
      // provider sees no UUID here, it's the empty-affectedObjects path
      // (which the filter ALLOWS without resolving). Log + neutral-return
      // — no infinite retry loop on a recipient filter that intentionally
      // allowed the notification through.
      console.warn(JSON.stringify({
        type: "notification_in_app_skipped",
        channel: "in_app",
        templateId: req.templateId,
        recipient: req.recipient.principal,
        executionId: req.executionId,
        reason: "recipient_user_uuid_missing",
      }));
      incCounter("tellus_side_effect_notification_dropped_total", { reason: "user_not_resolved" });
      return {
        ok: true,
        receiptId: `inapp:skipped:${req.executionId}:${req.recipient.principal}`,
        diagnostic: "recipient_user_uuid_missing — InApp provider skipped",
      };
    }
    try {
      const row = await insertNotification({
        recipientUserId: recipientUuid,
        templateId: req.templateId,
        templateParameters: req.templateParameters,
        channel: "in_app",
        actionTypeApiName: req.actionTypeApiName,
        executionId: req.executionId,
        ontologyId: req.ontologyId,
      });
      return {
        ok: true,
        receiptId: `inapp:${row.notification_id}`,
        diagnostic: `delivered to notification_inbox row ${row.notification_id}`,
      };
    } catch (err: any) {
      // PG drop → throw so the worker retries via the bounded backoff path.
      throw new Error(
        `inAppNotificationProvider: failed to insert notification_inbox row: ${err?.message ?? String(err)}`,
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Email — Phase 6.4 real transport.
//
// `EMAIL_PROVIDER_URL` selects one of two paths today:
//   * `https://…` (or `http://localhost…` for dev) — vendor HTTP webhook
//     (SendGrid/Mailgun/Postmark/SES-incoming) — POST a small JSON envelope
//     `{ to, from, subject, body, templateId, parameters, executionId,
//     actionTypeApiName, ontologyId }` through the safe-transport egress
//     guard. The vendor's API key is read from `EMAIL_PROVIDER_TOKEN` +
//     sent as the `Authorization: Bearer …` header.
//   * `smtp(s)://…` — direct SMTP. Phase 6.4 ships the UNAWIRED stub for
//     this path (nodemailer is not in `package.json` today); operators
//     who want native SMTP should `npm install nodemailer` first + the
//     path will need a follow-on to wire it. The SMTP URL is detected
//     + the provider returns a structured `EMAIL_PROVIDER_URL=smtp(s)://…`
//     error so the worker can dead-letter after the policy's maxAttempts.
// ---------------------------------------------------------------------------

import https from "https";
import * as http from "http";
import { assertEgressUrl, DEFAULT_EGRESS_POLICY } from "../services/webhookSafeTransport";
import { deriveIdempotencyKey } from "../services/webhookSafeTransport";

export const emailNotificationProvider: NotificationProvider = {
  channel: "email",
  async send(req): Promise<NotificationDeliveryResult> {
    incCounter("tellus_notification_email_total");
    const transportUrl = process.env.EMAIL_PROVIDER_URL;
    if (!transportUrl) {
      console.info(JSON.stringify({
        type: "notification_email",
        channel: "email",
        templateId: req.templateId,
        recipient: req.recipient.principal,
        executionId: req.executionId,
        diagnostic: "no EMAIL_PROVIDER_URL configured; e-mail notifications are stub-logged only.",
        note: "Configure EMAIL_PROVIDER_URL (https vendor webhook URL, or smtp(s):// once nodemailer is installed) to deliver.",
      }));
      return { ok: true, receiptId: `email-stub:${req.executionId}:${req.recipient.principal}`, diagnostic: "stub" };
    }
    // SMTP path — Phase 6.4 deferred pending nodemailer dep. Surface a
    // structured error so the operator sees the gap loudly rather than
    // silently swallowing notifications.
    if (/^smtp(s)?:\/\//i.test(transportUrl)) {
      throw new Error(
        "emailNotificationProvider: SMTP URL detected but nodemailer is not installed. Phase 6.4 ships the HTTP vendor webhook path; native SMTP is planned for a follow-on.",
      );
    }
    // HTTP vendor-webhook path — Phase 6.4 implementation.
    const egressCheck = assertEgressUrl(transportUrl, DEFAULT_EGRESS_POLICY);
    if (egressCheck.kind !== "ok") {
      const errs = (egressCheck as { kind: "errors"; errors: Array<{ code: string; message: string }> }).errors;
      throw new Error(
        `emailNotificationProvider: egress check failed for EMAIL_PROVIDER_URL: ${errs.map((e) => `${e.code}(${e.message})`).join("; ")}`,
      );
    }
    const fromAddress = process.env.EMAIL_PROVIDER_FROM || "no-reply@tellus.local";
    const idempotencyKey = deriveIdempotencyKey(`${req.executionId}:${req.recipient.principal}`, 0);
    const bodyJson = JSON.stringify({
      to: req.recipient.principal,
      from: fromAddress,
      templateId: req.templateId,
      parameters: req.templateParameters,
      executionId: req.executionId,
      actionTypeApiName: req.actionTypeApiName,
      ontologyId: req.ontologyId,
      channel: "email",
    });
    return await sendHttp(transportUrl, bodyJson, {
      "Authorization": process.env.EMAIL_PROVIDER_TOKEN ? `Bearer ${process.env.EMAIL_PROVIDER_TOKEN}` : undefined,
      "X-Idempotency-Key": idempotencyKey,
    }, `email:${idempotencyKey}`);
  },
};

// ---------------------------------------------------------------------------
// Slack-compatible — Phase 6.4 real transport: POSTs a JSON Slack
// incoming-webhook body (`{"text": …}`) to SLACK_WEBHOOK_URL through
// the safe-transport egress guard. Works with Slack, MS Teams adaptive
// cards, Discord, Discourse, anything that accepts a Slack-shaped JSON
// payload. Idempotency-Key header is sent so the receiving system can
// dedup retries.
// ---------------------------------------------------------------------------

export const slackCompatibleNotificationProvider: NotificationProvider = {
  channel: "slack_compatible",
  async send(req): Promise<NotificationDeliveryResult> {
    incCounter("tellus_notification_slack_total");
    const slackUrl = (process.env.SLACK_WEBHOOK_URL ?? "").trim();
    if (!slackUrl) {
      console.info(JSON.stringify({
        type: "notification_slack",
        channel: "slack_compatible",
        templateId: req.templateId,
        recipient: req.recipient.principal,
        executionId: req.executionId,
        diagnostic: "no SLACK_WEBHOOK_URL configured; Slack-compatible notifications are stub-logged only.",
        note: "Configure SLACK_WEBHOOK_URL to deliver.",
      }));
      return { ok: true, receiptId: `slack-stub:${req.executionId}`, diagnostic: "stub" };
    }
    const egressCheck = assertEgressUrl(slackUrl, DEFAULT_EGRESS_POLICY);
    if (egressCheck.kind !== "ok") {
      const errs = (egressCheck as { kind: "errors"; errors: Array<{ code: string; message: string }> }).errors;
      throw new Error(
        `slackCompatibleNotificationProvider: egress check failed for SLACK_WEBHOOK_URL: ${errs.map((e) => `${e.code}(${e.message})`).join("; ")}`,
      );
    }
    const idempotencyKey = deriveIdempotencyKey(`${req.executionId}:${req.recipient.principal}`, 0);
    // Slack incoming-webhook body: a text payload + the action context
    // as a JSON attachments block (so downstream tools that consume
    // Slack-shaped attachments see metadata too).
    const text = `[${req.actionTypeApiName}] (${req.templateId}) for ${req.recipient.principal} — execution ${req.executionId}`;
    const bodyJson = JSON.stringify({
      text,
      attachments: [
        {
          fallback: text,
          color: "good",
          fields: [
            { title: "Action Type", value: req.actionTypeApiName, short: true },
            { title: "Template", value: req.templateId, short: true },
            { title: "Recipient", value: req.recipient.principal, short: true },
            { title: "Execution ID", value: req.executionId, short: false },
          ],
        },
      ],
    });
    return await sendHttp(slackUrl, bodyJson, {
      "X-Idempotency-Key": idempotencyKey,
    }, `slack:${idempotencyKey}`);
  },
};

// ---------------------------------------------------------------------------
// Shared https/http POST helper used by EmailProvider + SlackProvider.
// Returns { ok: true, receiptId } on 2xx; throws on transport failure /
// non-2xx so the worker's bounded backoff retries, with a non-trivial
// redacted error message (no Authorization header values, no body).
// ---------------------------------------------------------------------------

async function sendHttp(
  url: string,
  bodyJson: string,
  headers: Record<string, string | undefined>,
  receiptIdSeed: string,
): Promise<NotificationDeliveryResult> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (e: any) {
    throw new Error(`sendHttp: invalid URL '${url}': ${e?.message ?? String(e)}`);
  }
  const lib = parsedUrl.protocol === "https:" ? https : http;
  return new Promise<NotificationDeliveryResult>((resolveP, rejectP) => {
    const req = lib.request(
      parsedUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "tellus-notification/1",
          ...Object.fromEntries(
            Object.entries(headers).filter(([, v]) => v !== undefined),
          ),
        },
        timeout: 10_000,
      },
      (res) => {
        let respBody = "";
        res.on("data", (chunk) => {
          respBody += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolveP({
              ok: true,
              receiptId: receiptIdSeed,
              diagnostic: `HTTP ${res.statusCode}`,
            });
          } else {
            rejectP(
              new Error(
                `sendHttp: HTTP ${res.statusCode} from '${parsedUrl.host}${parsedUrl.pathname}' (response body length=${respBody.length}, redacted)`,
              ),
            );
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("sendHttp: request timed out after 10s"));
    });
    req.on("error", (err) => {
      rejectP(new Error(`sendHttp: transport error: ${err?.message ?? String(err)}`));
    });
    req.write(bodyJson);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Registry — Phase 5 ships an in-process registry; Phase 6 will plug a
// per-ontology-configurable registry mapping notification-template-id →
// provider-of-choice. The actionExecutor / worker queries this for the
// provider matching the request's channel.
// ---------------------------------------------------------------------------

const registry: Map<NotificationChannel, NotificationProvider> = new Map([
  ["in_app", inAppNotificationProvider],
  ["email", emailNotificationProvider],
  ["slack_compatible", slackCompatibleNotificationProvider],
]);

export function getNotificationProvider(channel: NotificationChannel): NotificationProvider | null {
  return registry.get(channel) ?? null;
}

export function registerNotificationProvider(
  channel: NotificationChannel,
  provider: NotificationProvider,
): void {
  registry.set(channel, provider);
}
