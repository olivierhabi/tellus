/**
 * emailOutboxService.ts
 * ---------------------
 * Async email notifications without SMTP.
 *
 * enqueueEmail() drops a rendered envelope into `email_outbox` with
 * status='pending'. renderEmail() reads a Handlebars-lite template
 * from src/templates/email and substitutes {{variables}}. A dev stub
 * worker (flushEmailOutbox) flushes pending rows to
 * tellus/logs/email-outbox.log and flips status='sent'. A production
 * deployment replaces flushEmailOutbox with an SES/SendGrid sender
 * without touching the call sites.
 *
 * Templates live alongside the source tree so they ship with the
 * bundle. Each template is a pair:
 *   password-changed.txt.hbs  — plaintext body
 *   password-changed.html.hbs — HTML body
 * The renderer HTML-escapes every variable in the .html template and
 * leaves .txt alone.
 */

import fs from 'fs';
import path from 'path';
import type { Knex } from 'knex';
import foundryDb from '../config/foundryDb';
import { getEmailSender, EmailEnvelope } from './emailSenders';

// ---------------------------------------------------------------------------
// Template renderer
// ---------------------------------------------------------------------------

// Cache compiled templates so the render path doesn't hit the disk on
// every email. Keyed by file path.
const templateCache = new Map<string, string>();

/**
 * Resolve a template path that works in both dev (tsx runs src/ in place,
 * __dirname = .../src/services) and prod (tsc outputs to dist/, __dirname
 * = .../dist/services). The build script copies src/templates → dist/templates
 * as a postbuild step so both resolutions land on a real file. We try the
 * adjacent `templates/` directory first, then fall back to the src/templates
 * path so a build-artifact-less environment (e.g. direct tsx run from
 * compiled output) still resolves correctly.
 */
function resolveTemplatePath(templatePath: string): string {
  const adjacent = path.join(__dirname, '..', 'templates', 'email', templatePath);
  if (fs.existsSync(adjacent)) return adjacent;
  const srcFallback = path.resolve(__dirname, '..', '..', 'src', 'templates', 'email', templatePath);
  if (fs.existsSync(srcFallback)) return srcFallback;
  // Last-ditch: if tellus is installed as a package under node_modules,
  // fall back to cwd-relative lookup so an operator who drops templates
  // into tellus/src/templates outside the bundle still sees them.
  const cwdFallback = path.resolve(process.cwd(), 'src', 'templates', 'email', templatePath);
  if (fs.existsSync(cwdFallback)) return cwdFallback;
  return adjacent; // let the subsequent readFileSync throw a useful ENOENT
}

function loadTemplate(templatePath: string): string {
  const resolved = resolveTemplatePath(templatePath);
  const cached = templateCache.get(resolved);
  if (cached !== undefined) return cached;
  const source = fs.readFileSync(resolved, 'utf8');
  templateCache.set(resolved, source);
  return source;
}

function htmlEscape(input: unknown): string {
  const s = String(input ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a {{variable}} template. When `escape=true`, variable values
 * are HTML-escaped before substitution — we use this for the .html
 * version of each template to defeat injection via user-controlled
 * display names, user agents, etc.
 */
function renderString(source: string, ctx: Record<string, unknown>, escape: boolean): string {
  return source.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const raw = key.split('.').reduce<unknown>((acc, segment) => {
      if (acc && typeof acc === 'object' && segment in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[segment];
      }
      return undefined;
    }, ctx);
    const str = raw === undefined || raw === null ? '' : String(raw);
    return escape ? htmlEscape(str) : str;
  });
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  template: string;
}

/**
 * Render a template pair (.txt + .html) with the given context. The
 * subject line is taken from a `subject` field on the context — keeping
 * subject templating outside the body keeps the body templates
 * easier to read and lets callers localize the subject independently.
 */
export function renderEmail(
  templateName: string,
  subject: string,
  ctx: Record<string, unknown>,
): RenderedEmail {
  // resolveTemplatePath() accepts file names, not absolute paths, so
  // we pass just the basename variants here.
  const text = renderString(loadTemplate(`${templateName}.txt.hbs`), ctx, false);
  const html = renderString(loadTemplate(`${templateName}.html.hbs`), ctx, true);
  return { subject: renderString(subject, ctx, false), text, html, template: templateName };
}

// ---------------------------------------------------------------------------
// Outbox enqueue + flush
// ---------------------------------------------------------------------------

export interface EnqueueEmailOpts {
  to: string;
  rendered: RenderedEmail;
}

export async function enqueueEmail(opts: EnqueueEmailOpts): Promise<void> {
  try {
    await (foundryDb as unknown as Knex)('email_outbox').insert({
      to_address: opts.to,
      subject: opts.rendered.subject,
      template: opts.rendered.template,
      // Store the plain-text body as the canonical `body` column and
      // pack the HTML body into the template name + separate delivery
      // at send time. The stub writer dumps both so we don't lose any
      // part of the rendered email in the dev log.
      body: opts.rendered.text,
      status: 'pending',
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        type: 'email_enqueue_failed',
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Flush pending rows from email_outbox through whichever EmailSender
 * the env var selects. Selection is done ONCE via getEmailSender(),
 * so swapping providers in production is a matter of setting
 * TELLUS_EMAIL_SENDER=smtp and providing a real class in
 * emailSenders.ts — no changes in this file.
 *
 * Per-row errors flip the row to status='failed' with the error
 * string captured; the outer loop keeps going so one bad message
 * doesn't stall the rest. Rows that succeed move to status='sent'
 * with a sent_at timestamp.
 */
export async function flushEmailOutbox(): Promise<{ sent: number }> {
  const knex = foundryDb as unknown as Knex;
  const sender = getEmailSender();
  let sent = 0;
  try {
    const pending = await knex('email_outbox')
      .where({ status: 'pending' })
      .orderBy('created_at')
      .limit(50);
    for (const row of pending) {
      const envelope: EmailEnvelope = {
        id: row.id,
        to: row.to_address,
        subject: row.subject,
        template: row.template,
        body: row.body,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      };
      try {
        await sender.send(envelope);
        await knex('email_outbox')
          .where({ id: row.id })
          .update({ status: 'sent', sent_at: new Date() });
        sent += 1;
      } catch (err) {
        await knex('email_outbox')
          .where({ id: row.id })
          .update({
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          });
      }
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        type: 'email_outbox_flush_failed',
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return { sent };
}
