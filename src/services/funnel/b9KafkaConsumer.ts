// B9.08 — Kafka consumer that triggers a funnel run when an
// object_type updated event arrives.
//
// Design: each call to handleEvent() validates the payload shape and,
// if it's a tellus.oms.object-type.updated event, invokes the supplied
// `triggerFn`. The actual Kafka subscription is wired in the worker;
// this class is testable purely via direct event injection.
export interface OmsUpdateEvent {
  objectType?: string;
  objectTypeRid?: string;
  ontologyRid?: string;
  branchRid?: string | null;
  etag?: number;
}

export type TriggerFn = (objectTypeRid: string, ontologyRid: string, branchRid: string | null) => Promise<void>;

export class B9KafkaConsumer {
  /** Returns true if the event was handled (matched + dispatched). */
  async handleEvent(event: unknown, triggerFn: TriggerFn): Promise<boolean> {
    if (!event || typeof event !== 'object') return false;
    const e = event as OmsUpdateEvent;
    if (e.objectType !== 'tellus.oms.object-type.updated') return false;
    if (!e.objectTypeRid || !e.ontologyRid) return false;
    await triggerFn(e.objectTypeRid, e.ontologyRid, e.branchRid ?? null);
    return true;
  }
}
export const b9KafkaConsumer = new B9KafkaConsumer();
