/**
 * emailSenders.ts
 * ---------------
 * Pluggable EmailSender abstraction. `flushEmailOutbox` in
 * emailOutboxService.ts picks one of these at runtime via the
 * `TELLUS_EMAIL_SENDER` env var. The dev default (`logfile`)
 * appends to tellus/logs/email-outbox.log so the full pipeline
 * stays exercisable without a real SMTP endpoint. Swapping in a
 * production sender means adding a new class here and pointing
 * the env var at it — no call-site changes needed.
 *
 * Contract:
 *   • send(email) resolves when the message has been handed off
 *     to the upstream provider. A rejected promise is retried
 *     (the outbox row goes to status=failed with the error string).
 *   • Implementations must never throw synchronously — all errors
 *     flow through the returned Promise.
 *   • Implementations must not mutate the EmailEnvelope.
 */

import fs from 'fs';
import path from 'path';

export interface EmailEnvelope {
  id: string;
  to: string;
  subject: string;
  template: string | null;
  /** Plain-text body — always present. */
  body: string;
  /** Best-effort HTML body — optional; not all templates have one. */
  html?: string;
  createdAt: Date;
}

export interface EmailSender {
  readonly name: string;
  send(email: EmailEnvelope): Promise<void>;
}

// ---------------------------------------------------------------------------
// LogFileSender — dev default. Appends JSONL to tellus/logs/email-outbox.log
// ---------------------------------------------------------------------------

export class LogFileSender implements EmailSender {
  readonly name = 'logfile';

  constructor(private readonly logPath: string) {}

  async send(email: EmailEnvelope): Promise<void> {
    const dir = path.dirname(this.logPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        sender: this.name,
        id: email.id,
        to: email.to,
        subject: email.subject,
        template: email.template,
        body: email.body,
        html: email.html,
      }) + '\n';
    await fs.promises.appendFile(this.logPath, line);
  }
}

// ---------------------------------------------------------------------------
// ConsoleSender — logs to stdout in a human-readable form. Used by tests
// that want to verify the pipeline fired without touching the filesystem.
// ---------------------------------------------------------------------------

export class ConsoleSender implements EmailSender {
  readonly name = 'console';

  async send(email: EmailEnvelope): Promise<void> {
    // eslint-disable-next-line no-console
    console.info(
      `[email:${this.name}] to=${email.to} subject=${JSON.stringify(email.subject)} template=${email.template}`,
    );
  }
}

// ---------------------------------------------------------------------------
// SmtpSenderStub — placeholder for a real production sender. Throws a
// loud error if invoked without TELLUS_SMTP_URL set, so the first
// production run fails fast instead of silently dropping mail.
// ---------------------------------------------------------------------------

export class SmtpSenderStub implements EmailSender {
  readonly name = 'smtp';

  async send(_email: EmailEnvelope): Promise<void> {
    throw new Error(
      'SmtpSenderStub is a placeholder — wire a real SMTP/SES/SendGrid ' +
        'client here before setting TELLUS_EMAIL_SENDER=smtp in production.',
    );
  }
}

// ---------------------------------------------------------------------------
// Sender selection
// ---------------------------------------------------------------------------

export interface SenderOptions {
  logPath?: string;
}

let _instance: EmailSender | null = null;

/**
 * Return the process-wide EmailSender. The selection is driven by
 * `TELLUS_EMAIL_SENDER` (one of `logfile` | `console` | `smtp`) and
 * frozen after the first call so repeat lookups are cheap.
 */
export function getEmailSender(opts: SenderOptions = {}): EmailSender {
  if (_instance) return _instance;
  const kind = (process.env.TELLUS_EMAIL_SENDER || 'logfile').toLowerCase();
  const logPath = opts.logPath || path.join(process.cwd(), 'logs', 'email-outbox.log');
  switch (kind) {
    case 'console':
      _instance = new ConsoleSender();
      break;
    case 'smtp':
      _instance = new SmtpSenderStub();
      break;
    case 'logfile':
    default:
      _instance = new LogFileSender(logPath);
      break;
  }
  return _instance;
}

/** Tests override the sender by resetting the module-level instance. */
export function __setEmailSenderForTests(sender: EmailSender | null): void {
  _instance = sender;
}
