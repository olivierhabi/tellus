// =============================================================================
// Workshop Actions Adapter — D-02 boundary
//
// Workshop talks to "Actions" through this adapter. In monolith deploy
// the adapter calls in-process actionExecutor + actionValidator. In tests
// it is a recording fake.
//
// Spec §B10:
//   - Branch + JWT forwarded verbatim (§0.5, §0.6)
//   - validate returns same shape as apply's validation phase
//   - apply produces an "edits" envelope with modifiedProperties
//   - apply may throw ActionStaleObject (no auto-retry, per spec)
//   - apply emits a "WS push" containing objectsChanged
// =============================================================================

import type { OssRequestContext } from "./ossAdapter.js";

export interface ActionApplyRequest {
  ontologyRid: string;
  actionTypeApiName: string;
  parameters: Record<string, unknown>;
}

export interface ActionValidationResult {
  valid: boolean;
  errors: ReadonlyArray<{
    path: string;
    code: string;
    message: string;
  }>;
}

export interface ActionEdits {
  /** Object primary keys that were modified, by object type. */
  modifiedObjects: ReadonlyArray<{
    objectTypeApiName: string;
    primaryKey: string;
  }>;
  /** Property api-names that changed (deduplicated, sorted). */
  modifiedProperties: ReadonlyArray<string>;
  /** Created object primary keys, if any. */
  createdObjects: ReadonlyArray<{
    objectTypeApiName: string;
    primaryKey: string;
  }>;
  /** Deleted object primary keys, if any. */
  deletedObjects: ReadonlyArray<{
    objectTypeApiName: string;
    primaryKey: string;
  }>;
}

export interface ActionApplyResponse {
  /** Validation phase output — same shape as validate(). */
  validation: ActionValidationResult;
  /** Empty when validation.valid === false. */
  edits: ActionEdits;
}

/** Thrown by adapters when a stale object would be written. */
export class StaleObjectError extends Error {
  constructor(
    readonly objectTypeApiName: string,
    readonly primaryKey: string,
    readonly expectedVersion: string,
    readonly actualVersion: string,
  ) {
    super(
      `stale object ${objectTypeApiName}:${primaryKey} expected ${expectedVersion} actual ${actualVersion}`,
    );
    this.name = "StaleObjectError";
  }
}

export interface WorkshopActionsAdapter {
  validate(
    req: ActionApplyRequest,
    ctx: OssRequestContext,
  ): Promise<ActionValidationResult>;
  apply(
    req: ActionApplyRequest,
    ctx: OssRequestContext,
  ): Promise<ActionApplyResponse>;
}

export interface RecordedActionsCall {
  kind: "validate" | "apply";
  request: ActionApplyRequest;
  context: OssRequestContext;
  at: number;
}

export class RecordingActionsAdapter implements WorkshopActionsAdapter {
  readonly calls: RecordedActionsCall[] = [];
  constructor(
    private readonly nextValidate: (
      r: ActionApplyRequest,
      c: OssRequestContext,
    ) =>
      | ActionValidationResult
      | Promise<ActionValidationResult> = () => ({
      valid: true,
      errors: [],
    }),
    private readonly nextApply: (
      r: ActionApplyRequest,
      c: OssRequestContext,
    ) => ActionApplyResponse | Promise<ActionApplyResponse> = () => ({
      validation: { valid: true, errors: [] },
      edits: {
        modifiedObjects: [],
        modifiedProperties: [],
        createdObjects: [],
        deletedObjects: [],
      },
    }),
  ) {}

  async validate(
    req: ActionApplyRequest,
    ctx: OssRequestContext,
  ): Promise<ActionValidationResult> {
    this.calls.push({ kind: "validate", request: req, context: ctx, at: Date.now() });
    return await this.nextValidate(req, ctx);
  }
  async apply(
    req: ActionApplyRequest,
    ctx: OssRequestContext,
  ): Promise<ActionApplyResponse> {
    this.calls.push({ kind: "apply", request: req, context: ctx, at: Date.now() });
    return await this.nextApply(req, ctx);
  }
  reset(): void {
    this.calls.length = 0;
  }
}

let _adapter: WorkshopActionsAdapter = new RecordingActionsAdapter();
export function getActions(): WorkshopActionsAdapter {
  return _adapter;
}
export function setActions(a: WorkshopActionsAdapter): WorkshopActionsAdapter {
  const prev = _adapter;
  _adapter = a;
  return prev;
}
