// ---------------------------------------------------------------------------
// Inline-edit batch planning — pure pre-validation, conflict detection, and
// coalescing for bulk inline-edit submission (Pillar 3).
//
// Foundry model: edits are "validated and submitted in bulk" and "will succeed
// if they all pass parameter and global submission criteria." A batch that
// would "edit the same object twice" through conflicting actions is rejected.
// Multi-property edits on the SAME object through the SAME action coalesce
// into a single action application (Foundry's "every parameter defaults to
// the existing value" model makes this safe).
//
// This pure function runs BEFORE any execution: it validates every edit,
// detects same-object conflicts, and coalesces compatible edits. The caller
// (the route handler) uses the plan to decide whether to execute (all pass)
// or reject (any fail → commit nothing, return per-edit errors).
//
// Pure + total — no DB, no IO. Unit-tested.
// ---------------------------------------------------------------------------

export interface InlineEditRequest {
  /** The edited property's apiName (determines which action to invoke). */
  readonly propertyApiName: string;
  /** The object's primary-key value (identifies the object being edited). */
  readonly primaryKey: string | number;
  /** The new value for the property. */
  readonly value: unknown;
  /** The action-type apiName bound to this property (from ontology metadata). */
  readonly actionApiName: string;
}

export interface CoalescedEdit {
  /** Coalesced action application — one per (object, action). */
  readonly actionApiName: string;
  readonly primaryKey: string | number;
  /** Merged parameters: PK param + all edited property params. */
  readonly parameters: Record<string, unknown>;
  /** Indices in the original request array that were coalesced into this edit. */
  readonly sourceIndices: number[];
}

export interface InlineEditBatchPlan {
  /** Edits to execute (coalesced, pre-validated). Empty if any validation failed. */
  readonly edits: CoalescedEdit[];
  /** Per-request validation results. */
  readonly results: Array<{
    readonly index: number;
    readonly valid: boolean;
    readonly error?: string;
  }>;
  /** True when all edits passed validation and the batch can be submitted. */
  readonly allValid: boolean;
  /** Conflict errors (same-object conflicts detected during planning). */
  readonly conflicts: string[];
}

/**
 * Validate, detect conflicts, and coalesce a batch of inline-edit requests.
 *
 * @param requests The raw edit requests from the client.
 * @param pkParameterMap Maps actionApiName → the PK parameter apiName for that
 *   action (used to construct the action's parameter object). Resolved by the
 *   caller from the ontology's action-type definitions.
 * @returns A batch plan. If `allValid` is false, `edits` is empty and the
 *   caller must NOT execute anything.
 */
export function planInlineEditBatch(
  requests: ReadonlyArray<InlineEditRequest>,
  pkParameterMap: ReadonlyMap<string, string>,
): InlineEditBatchPlan {
  const results: InlineEditBatchPlan["results"] = [];
  const conflicts: string[] = [];

  // Step 1 — validate each request has the required fields.
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    if (!req || typeof req !== "object") {
      results.push({ index: i, valid: false, error: "Invalid request shape." });
      continue;
    }
    if (!req.propertyApiName || typeof req.propertyApiName !== "string") {
      results.push({ index: i, valid: false, error: "propertyApiName is required." });
      continue;
    }
    if (req.primaryKey == null || String(req.primaryKey).length === 0) {
      results.push({ index: i, valid: false, error: "primaryKey is required." });
      continue;
    }
    if (!req.actionApiName || typeof req.actionApiName !== "string") {
      results.push({ index: i, valid: false, error: "actionApiName is required." });
      continue;
    }
    if (req.value === undefined) {
      results.push({ index: i, valid: false, error: "value is required (use null for clearing)." });
      continue;
    }
    const pkParam = pkParameterMap.get(req.actionApiName);
    if (!pkParam) {
      results.push({
        index: i,
        valid: false,
        error: `No PK parameter found for action "${req.actionApiName}".`,
      });
      continue;
    }
    results.push({ index: i, valid: true });
  }

  const allValid = results.every((r) => r.valid);
  if (!allValid) {
    return { edits: [], results, allValid: false, conflicts };
  }

  // Step 2 — detect same-object conflicts. Two edits to the same object PK
  // through DIFFERENT actions is a conflict. Two edits to the same object PK
  // through the SAME action on DIFFERENT properties is NOT a conflict — they
  // coalesce. Two edits to the same object PK + same property with different
  // values is a conflict.
  for (let i = 0; i < requests.length; i++) {
    for (let j = i + 1; j < requests.length; j++) {
      const a = requests[i];
      const b = requests[j];
      if (a.primaryKey !== b.primaryKey) continue;
      if (a.actionApiName !== b.actionApiName) {
        conflicts.push(
          `Edits ${i} and ${j} target the same object (PK: ${a.primaryKey}) through different actions ("${a.actionApiName}" vs "${b.actionApiName}").`,
        );
      } else if (a.propertyApiName === b.propertyApiName) {
        // Same object, same action, same property — only a conflict if values differ.
        if (JSON.stringify(a.value) !== JSON.stringify(b.value)) {
          conflicts.push(
            `Edits ${i} and ${j} write conflicting values to property "${a.propertyApiName}" on object (PK: ${a.primaryKey}).`,
          );
        }
      }
    }
  }

  if (conflicts.length > 0) {
    return { edits: [], results, allValid: false, conflicts };
  }

  // Step 3 — coalesce. Group by (primaryKey, actionApiName). Multiple property
  // edits on the same object sharing the same action become a single action
  // application with merged parameters.
  const coalesceKey = (pk: string | number, action: string) => `${pk}::${action}`;
  const coalesced = new Map<string, CoalescedEdit>();

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    const key = coalesceKey(req.primaryKey, req.actionApiName);
    const pkParam = pkParameterMap.get(req.actionApiName)!;
    const existing = coalesced.get(key);
    if (existing) {
      // Merge: add this property's value to the parameters.
      existing.parameters[req.propertyApiName] = req.value;
      existing.sourceIndices.push(i);
    } else {
      coalesced.set(key, {
        actionApiName: req.actionApiName,
        primaryKey: req.primaryKey,
        parameters: {
          [pkParam]: req.primaryKey,
          [req.propertyApiName]: req.value,
        },
        sourceIndices: [i],
      });
    }
  }

  return {
    edits: [...coalesced.values()],
    results,
    allValid: true,
    conflicts,
  };
}
