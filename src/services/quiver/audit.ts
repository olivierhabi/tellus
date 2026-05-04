// Quiver audit shim (G-10).  Same indirection pattern as workshop/audit.ts.
//
// Every mutating endpoint emits exactly one audit row via emitQuiverAudit.
// Tests swap the emitter via setAuditEmitter() to capture without touching
// the real audit pipeline.

export type QuiverAuditAction =
  | "QUIVER_ANALYSIS_CREATED"
  | "QUIVER_ANALYSIS_UPDATED"
  | "QUIVER_ANALYSIS_DELETED"
  | "QUIVER_ANALYSIS_VERSION_SAVED"
  | "QUIVER_ANALYSIS_REVERTED"
  | "QUIVER_OT_INSTRUCTION_APPLIED"
  | "QUIVER_DASHBOARD_PUBLISHED"
  | "QUIVER_DASHBOARD_EMBED_REGISTERED"
  | "QUIVER_VISUAL_FUNCTION_PUBLISHED"
  | "QUIVER_AIP_INVOKED"
  | "QUIVER_COMPUTE_INVOKED";

export interface QuiverAuditEvent {
  actorSubject: string;
  action: QuiverAuditAction;
  rid: string;
  result: "SUCCESS" | "FAILURE";
  branch?: string;
  beforeEtag?: string | null;
  afterEtag?: string | null;
  details?: Record<string, unknown>;
}

export type AuditEmitter = (event: QuiverAuditEvent) => Promise<void>;

let emitter: AuditEmitter = defaultEmitter;

async function defaultEmitter(event: QuiverAuditEvent): Promise<void> {
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
    category: "QUIVER",
    action: event.action,
    result: event.result,
    details: {
      rid: event.rid,
      branch: event.branch ?? null,
      beforeEtag: event.beforeEtag ?? null,
      afterEtag: event.afterEtag ?? null,
      ...(event.details ?? {}),
    },
  });
}

export async function emitQuiverAudit(event: QuiverAuditEvent): Promise<void> {
  await emitter(event);
}

export function setAuditEmitter(next: AuditEmitter): void {
  emitter = next;
}

export function resetAuditEmitter(): void {
  emitter = defaultEmitter;
}
