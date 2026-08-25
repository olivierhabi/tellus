import { incCounter } from "../services/funnel/metrics";

export interface NotificationSpec {
  type: "email" | "push" | "slack";
  recipients: string[];
  subject?: string;
  body?: string;
  templateId?: string;
}

export interface NotificationPayload {
  executionId: string;
  actionTypeApiName: string;
  ontologyId: string;
  result: string;
  executedBy: string;
  affectedObjects: Array<{ objectType: string; primaryKey: string; operation: string }>;
  timestamp: string;
}

export interface NotificationResult {
  type: string;
  recipients: string[];
  ok: boolean;
  error?: string;
}

export function parseNotificationSpecs(sideEffects: unknown): NotificationSpec[] {
  if (sideEffects == null) return [];
  
  const raw = (sideEffects as { notifications?: unknown[] }).notifications;
  if (!Array.isArray(raw)) return [];
  
  const specs: NotificationSpec[] = [];
  for (const item of raw) {
    if (item && typeof item === "object") {
      const n = item as NotificationSpec;
      if (["email", "push", "slack"].includes(n.type) && n.recipients?.length) {
        specs.push({
          type: n.type,
          recipients: n.recipients,
          subject: n.subject || `Action ${n.type}`,
          body: n.body,
          templateId: n.templateId,
        });
      }
    }
  }
  return specs;
}

export async function sendNotifications(
  sideEffects: unknown,
  payload: NotificationPayload,
): Promise<NotificationResult[]> {
  const specs = parseNotificationSpecs(sideEffects);
  if (specs.length === 0) return [];
  
  const results: NotificationResult[] = [];
  
  for (const spec of specs) {
    const result = await mockSendNotification(spec, payload);
    results.push(result);
    
    try {
      incCounter(
        result.ok
          ? "tellus_action_notification_sent_total"
          : "tellus_action_notification_failed_total",
      );
    } catch {
      // metrics are best-effort
    }
    
    if (!result.ok) {
      console.warn(
        `[action:${payload.actionTypeApiName}] ${spec.type} notification failed (non-fatal): ${result.error}`,
      );
    }
  }
  
  return results;
}

async function mockSendNotification(
  spec: NotificationSpec,
  payload: NotificationPayload,
): Promise<NotificationResult> {
  const result: NotificationResult = {
    type: spec.type,
    recipients: spec.recipients,
    ok: false,
  };
  
  try {
    console.log(
      `[MOCK NOTIFICATION] ${spec.type.toUpperCase()} to ${spec.recipients.join(", ")}: ` +
      `Action '${payload.actionTypeApiName}' ${payload.result} by ${payload.executedBy} ` +
      `(${payload.affectedObjects.length} objects affected)`,
    );
    
    result.ok = true;
    return result;
  } catch (err) {
    result.error = (err as Error).message;
    return result;
  }
}
