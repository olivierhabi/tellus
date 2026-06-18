// Workshop audit indirection.
//
// Spec §B01 acceptance: every mutating call writes one audit row with
// the correct action name. The existing `auditEventService.emitAuditEvent`
// is the canonical sink; this shim adds:
//   - a `Workshop`-namespaced category
//   - a swappable `AuditEmitter` for tests, so a per-schema integration
//     test can spy on emissions without involving foundryDb (the real
//     audit table lives there, not in tellus_db).
// Decision D-09 + brief §0 (audit is non-negotiable).

export type WorkshopAuditAction =
  | "WORKSHOP_MODULE_CREATED"
  | "WORKSHOP_MODULE_UPDATED"
  | "WORKSHOP_MODULE_DELETED"
  | "WORKSHOP_MODULE_PUBLISHED"
  | "WORKSHOP_MODULE_ROLLED_BACK"
  | "WORKSHOP_ACTION_APPLIED"
  | "WORKSHOP_ACTION_TYPE_CREATED"
  | "WORKSHOP_ACTION_TYPE_UPDATED";

export interface WorkshopAuditEvent {
  actorSubject: string;
  action: WorkshopAuditAction;
  rid: string;
  result: "SUCCESS" | "FAILURE";
  details?: Record<string, unknown>;
}

export type AuditEmitter = (event: WorkshopAuditEvent) => Promise<void>;

let emitter: AuditEmitter = defaultEmitter;

async function defaultEmitter(event: WorkshopAuditEvent): Promise<void> {
  // Lazy require so the integration harness can swap before the audit
  // service is ever loaded — and so unit tests don't pull foundryDb in.
  let emit: undefined | ((opts: unknown) => Promise<void>);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("../auditEventService") as {
      emitAuditEvent: (opts: unknown) => Promise<void>;
    };
    emit = mod.emitAuditEvent;
  } catch {
    emit = undefined;
  }
  if (!emit) return;
  await emit({
    keycloakSub: event.actorSubject,
    category: "WORKSHOP",
    action: event.action,
    result: event.result,
    details: { rid: event.rid, ...(event.details ?? {}) },
  });
}

export async function emitWorkshopAudit(
  event: WorkshopAuditEvent,
): Promise<void> {
  await emitter(event);
}

export function setAuditEmitter(next: AuditEmitter): void {
  emitter = next;
}

export function resetAuditEmitter(): void {
  emitter = defaultEmitter;
}
