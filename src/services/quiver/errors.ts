// Quiver — Conjure-style error envelope (G-02).
//
// Shape: { errorCode, errorName: "Tellus:Quiver:<PascalCase>", errorInstanceId, parameters }.
// Codes follow the taxonomy from `quiver-tasks.md` §"Error Code Taxonomy".

import { randomUUID } from "node:crypto";

export type QuiverErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "FAILED_PRECONDITION"
  | "DEADLINE_EXCEEDED"
  | "RESOURCE_EXHAUSTED"
  | "CONFLICT"
  | "INTERNAL"
  | "UNAUTHENTICATED";

const CODE_TO_STATUS: Record<QuiverErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  PERMISSION_DENIED: 403,
  FAILED_PRECONDITION: 412,
  DEADLINE_EXCEEDED: 504,
  RESOURCE_EXHAUSTED: 429,
  CONFLICT: 409,
  INTERNAL: 500,
  UNAUTHENTICATED: 401,
};

export interface QuiverErrorEnvelope {
  errorCode: QuiverErrorCode;
  errorName: string; // "Tellus:Quiver:<PascalCase>"
  errorInstanceId: string; // uuidv4
  parameters: Record<string, unknown>;
}

export class QuiverError extends Error {
  public readonly status: number;
  public readonly envelope: QuiverErrorEnvelope;

  constructor(
    code: QuiverErrorCode,
    name: string,
    parameters: Record<string, unknown> = {},
    status?: number,
  ) {
    super(`${name}: ${JSON.stringify(parameters)}`);
    this.name = "QuiverError";
    this.status = status ?? CODE_TO_STATUS[code];
    this.envelope = {
      errorCode: code,
      errorName: name,
      errorInstanceId: randomUUID(),
      parameters,
    };
  }
}

const E = (
  code: QuiverErrorCode,
  name: string,
  status?: number,
) =>
  (parameters: Record<string, unknown> = {}) =>
    new QuiverError(code, `Tellus:Quiver:${name}`, parameters, status);

// === Constructors used by B1 (Analysis Document Storage) =====================
export const invalidAnalysisRequest = E("INVALID_ARGUMENT", "InvalidAnalysisRequest");
export const parentFolderNotFound = E("INVALID_ARGUMENT", "ParentFolderNotFound");
export const templateNotFound = E("NOT_FOUND", "TemplateNotFound");
export const invalidObjectSetReference = E("INVALID_ARGUMENT", "InvalidObjectSetReference");
export const analysisNotFound = E("NOT_FOUND", "AnalysisNotFound");
export const versionMismatch = E("FAILED_PRECONDITION", "VersionMismatch");
export const idempotencyKeyReplay = E("CONFLICT", "IdempotencyKeyReplay");
export const compassUnavailable = E("INTERNAL", "CompassUnavailable");
/** Fail-closed deny raised when no CompassPort is wired (deny-by-wiring):
 *  analysis authorization refuses to allow-all just because Compass is
 *  absent. 503 — the deployment is missing its authorization wiring, not
 *  the client's permissions. */
export const compassNotConfigured = E("FAILED_PRECONDITION", "CompassNotConfigured", 503);
export const unauthenticated = E("UNAUTHENTICATED", "Unauthenticated");
export const insufficientPermission = E("PERMISSION_DENIED", "InsufficientPermission");
export const markingRequired = E("PERMISSION_DENIED", "MarkingRequired");
export const analysisTooLarge = E("INVALID_ARGUMENT", "AnalysisTooLarge", 413);

// === Constructors used by B2 (DAG validator) =================================
export const cardTypeInputMismatch = E("INVALID_ARGUMENT", "CardTypeInputMismatch");
export const cyclicDag = E("INVALID_ARGUMENT", "CyclicDag");
export const invalidParameterBinding = E("INVALID_ARGUMENT", "InvalidParameterBinding");
export const cardLimitExceeded = E("INVALID_ARGUMENT", "CardLimitExceeded");
export const canvasLimitExceeded = E("INVALID_ARGUMENT", "CanvasLimitExceeded");
export const malformedInstruction = E("INVALID_ARGUMENT", "MalformedInstruction");

// === Constructors used by B3 (OT) ============================================
export const otBaseVersionTooOld = E("FAILED_PRECONDITION", "OtBaseVersionTooOld");
export const otTransformFailed = E("CONFLICT", "OtTransformFailed");

// === Constructors used by B4 (versioning) ===================================
export const versionNotFound = E("NOT_FOUND", "VersionNotFound");
export const workingStateNotFound = E("NOT_FOUND", "WorkingStateNotFound");

// === Constructors used by B5..B8 (compute) ==================================
export const computeDeadlineExceeded = E("DEADLINE_EXCEEDED", "ComputeDeadlineExceeded");
export const computeBackendError = E("INTERNAL", "ComputeBackendError");
export const objectSetLimitExceeded = E("INVALID_ARGUMENT", "ObjectSetLimitExceeded");
export const transformTableRowLimit = E("INVALID_ARGUMENT", "TransformTableRowLimit");
export const ossUnavailable = E("INTERNAL", "OssUnavailable");
export const ossQueryTimeout = E("DEADLINE_EXCEEDED", "OssQueryTimeout");
export const codexUnavailable = E("INTERNAL", "CodexUnavailable");
export const tsHydrationTimeout = E("DEADLINE_EXCEEDED", "TsHydrationTimeout");
export const hydrationTokenExpired = E("FAILED_PRECONDITION", "HydrationTokenExpired", 410);
export const noBackendForCardType = E("INTERNAL", "NoBackendForCardType");
export const actionApplyForbidden = E("PERMISSION_DENIED", "ActionApplyForbidden");

// === Constructors used by B9/B10 ============================================
export const llmToolUnauthorized = E("PERMISSION_DENIED", "LlmToolUnauthorized");
export const llmTimeout = E("DEADLINE_EXCEEDED", "LlmTimeout");
export const dashboardNotFound = E("NOT_FOUND", "DashboardNotFound");
export const visualFunctionNotFound = E("NOT_FOUND", "VisualFunctionNotFound");
export const exposedCanvasNotFound = E("INVALID_ARGUMENT", "ExposedCanvasNotFound");
export const exposedParameterNotFound = E("INVALID_ARGUMENT", "ExposedParameterNotFound");
export const visualFunctionRootNotFound = E("INVALID_ARGUMENT", "VisualFunctionRootNotFound");
export const compassRegistrationFailed = E("INTERNAL", "CompassRegistrationFailed");

// === Catch-all for unmapped failures =========================================
export const internal = E("INTERNAL", "Internal");

/** Discriminate QuiverError safely. */
export function isQuiverError(e: unknown): e is QuiverError {
  return e instanceof QuiverError;
}
