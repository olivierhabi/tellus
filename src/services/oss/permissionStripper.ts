// B10.09 — Permission stripping (mandatory_control).
//
// After OSS executes a search, before hits are returned to the caller,
// each hit must be filtered through the gatekeeper to drop documents
// the principal isn't allowed to see.  This is the "mandatory control"
// layer — Foundry-faithful semantics where the IR can't widen
// visibility past what the caller's role grants permit.
//
// We accept an injected `evaluateFn` (typically gatekeeperService.evaluateBatch)
// so the stripper is fully testable without a live DB.
export interface Hit { id: string; rid?: string; [k: string]: unknown }

export type EvaluateFn = (
  inputs: Array<{ principalId: string; operationId: string; resourceRid: string }>,
) => Promise<Map<string, { decision: 'ALLOW' | 'DENY'; reason?: string }>>;

export class PermissionStripper {
  /**
   * Strip hits the principal cannot view.
   *
   * The caller passes a `ridResolver` so the stripper can derive a
   * resource RID from each hit (e.g. `ri.compass.main.object.${id}`).
   * Hits whose decision is DENY are filtered out; the remaining hits
   * are returned in the original order.
   */
  async strip(opts: {
    principalId: string;
    operationId: string;
    hits: Hit[];
    ridResolver: (h: Hit) => string;
    evaluateFn: EvaluateFn;
  }): Promise<{ allowed: Hit[]; denied: number }> {
    if (opts.hits.length === 0) return { allowed: [], denied: 0 };
    const inputs = opts.hits.map((h) => ({
      principalId: opts.principalId,
      operationId: opts.operationId,
      resourceRid: opts.ridResolver(h),
    }));
    const decisions = await opts.evaluateFn(inputs);
    const allowed: Hit[] = [];
    let denied = 0;
    for (const h of opts.hits) {
      const key = `${opts.principalId}|${opts.operationId}|${opts.ridResolver(h)}`;
      const d = decisions.get(key);
      if (d?.decision === 'ALLOW') allowed.push(h);
      else denied++;
    }
    return { allowed, denied };
  }
}
export const permissionStripper = new PermissionStripper();
