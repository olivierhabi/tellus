// Workshop / G-01 — Conjure-style error envelope.
//
// Spec §0.1: every Workshop error is shaped as
//   { errorCode, errorName: "Tellus:Workshop:<PascalCase>", errorInstanceId, parameters }
// with a fixed mapping from `errorCode` -> HTTP status. Error names are part
// of the wire contract; clients depend on them, never on text.
//
// Decision D-03: contracts are Zod-typed; this module is the canonical
// envelope on the server side. The same shape is re-exported to
// `@workshop/contracts` so clients consume identical types.

import { randomUUID } from "node:crypto";

export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "CONFLICT",
  "PERMISSION_DENIED",
  "FAILED_PRECONDITION",
  "REQUEST_ENTITY_TOO_LARGE",
  "INTERNAL",
  "TIMEOUT",
  "UNAVAILABLE",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PERMISSION_DENIED: 403,
  FAILED_PRECONDITION: 412,
  REQUEST_ENTITY_TOO_LARGE: 413,
  INTERNAL: 500,
  TIMEOUT: 504,
  UNAVAILABLE: 503,
};

export interface WorkshopErrorEnvelope {
  errorCode: ErrorCode;
  errorName: string;
  errorInstanceId: string;
  parameters: Record<string, unknown>;
}

export class WorkshopError extends Error {
  readonly errorCode: ErrorCode;
  readonly errorName: string;
  readonly errorInstanceId: string;
  readonly parameters: Record<string, unknown>;
  readonly httpStatus: number;

  constructor(
    errorCode: ErrorCode,
    errorName: string,
    parameters: Record<string, unknown> = {},
  ) {
    super(`${errorName} (${errorCode})`);
    if (!/^Tellus:[A-Z][A-Za-z0-9]+:[A-Z][A-Za-z0-9]+$/.test(errorName)) {
      // §0.1: errorName MUST be in <Service>:<PascalCase> form. Reject at
      // construction so contract violations surface in dev not prod.
      throw new Error(
        `WorkshopError: invalid errorName "${errorName}" — expected Tellus:<Service>:<PascalCase>`,
      );
    }
    this.errorCode = errorCode;
    this.errorName = errorName;
    this.errorInstanceId = randomUUID();
    this.parameters = parameters;
    this.httpStatus = STATUS_BY_CODE[errorCode];
    this.name = "WorkshopError";
  }

  toEnvelope(): WorkshopErrorEnvelope {
    return {
      errorCode: this.errorCode,
      errorName: this.errorName,
      errorInstanceId: this.errorInstanceId,
      parameters: this.parameters,
    };
  }
}

// Convenience constructors for the B01 surface. Each named per spec §B01
// errors table.
export const moduleNotFound = (rid: string) =>
  new WorkshopError("NOT_FOUND", "Tellus:Workshop:ModuleNotFound", { rid });
export const resourceVersionMismatch = (
  rid: string,
  currentEtag: string | null,
) =>
  new WorkshopError(
    "FAILED_PRECONDITION",
    "Tellus:Workshop:ResourceVersionMismatch",
    { rid, currentEtag },
  );
export const moduleNameConflict = (
  parentFolderRid: string,
  displayName: string,
) =>
  new WorkshopError("CONFLICT", "Tellus:Workshop:ModuleNameConflict", {
    parentFolderRid,
    displayName,
  });
export const invalidModuleSchema = (
  reason: string,
  parameters: Record<string, unknown> = {},
) =>
  new WorkshopError("INVALID_ARGUMENT", "Tellus:Workshop:InvalidModuleSchema", {
    reason,
    ...parameters,
  });
export const ontologyNotFound = (ontologyRid: string) =>
  new WorkshopError("INVALID_ARGUMENT", "Tellus:Workshop:OntologyNotFound", {
    ontologyRid,
  });
export const parentFolderNotFound = (parentFolderRid: string) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:ParentFolderNotFound",
    { parentFolderRid },
  );
export const moduleTooLarge = (sizeBytes: number) =>
  new WorkshopError(
    "REQUEST_ENTITY_TOO_LARGE",
    "Tellus:Workshop:ModuleTooLarge",
    { sizeBytes, limitBytes: 2 * 1024 * 1024 },
  );
export const idempotencyKeyReused = (idempotencyKey: string) =>
  new WorkshopError("CONFLICT", "Tellus:Workshop:IdempotencyKeyReused", {
    idempotencyKey,
  });

// ---- B02 — module schema validator + variable-graph compiler --------------

export const duplicateVariableId = (duplicateId: string) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:DuplicateVariableId",
    { duplicateId },
  );

export const variableGraphCycle = (cyclePath: string[]) =>
  new WorkshopError("INVALID_ARGUMENT", "Tellus:Workshop:VariableGraphCycle", {
    cyclePath,
  });

export const orphanWidgetReference = (widgetId: string) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:OrphanWidgetReference",
    { widgetId },
  );

export const danglingVariableReference = (
  variableId: string,
  bindingPath: string,
) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:DanglingVariableReference",
    { variableId, bindingPath },
  );

export const variableTypeMismatch = (
  expected: string,
  actual: string,
  path: string,
) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:VariableTypeMismatch",
    { expected, actual, path },
  );

export const duplicateExternalId = (externalId: string) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:DuplicateExternalId",
    { externalId },
  );

export const embeddedModuleInterfaceUnsatisfied = (
  embeddedModuleRid: string,
  missingInterfaceVars: string[],
) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:EmbeddedModuleInterfaceUnsatisfied",
    { embeddedModuleRid, missingInterfaceVars },
  );

// ---- B03 — versioning + publish + resolve ---------------------------------

export const invalidSemver = (semver: string) =>
  new WorkshopError("INVALID_ARGUMENT", "Tellus:Workshop:InvalidSemver", {
    semver,
  });

export const moduleVersionNotFound = (rid: string, semver: string) =>
  new WorkshopError("NOT_FOUND", "Tellus:Workshop:ModuleVersionNotFound", {
    rid,
    semver,
  });

export const moduleNotPublished = (rid: string) =>
  new WorkshopError("NOT_FOUND", "Tellus:Workshop:ModuleNotPublished", {
    rid,
  });

export const semverTagImmutable = (rid: string, semver: string) =>
  new WorkshopError("CONFLICT", "Tellus:Workshop:SemverTagImmutable", {
    rid,
    semver,
  });

export const semverNotMonotonic = (
  rid: string,
  semver: string,
  highestPublishedSemver: string,
) =>
  new WorkshopError("CONFLICT", "Tellus:Workshop:SemverNotMonotonic", {
    rid,
    semver,
    highestPublishedSemver,
  });

// ---- B07 — Workshop filter compiler ---------------------------------------

export const unknownFilterProperty = (property: string, uiKind: string) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:UnknownFilterProperty",
    { property, uiKind },
  );

export const unsupportedFilterUiKind = (uiKind: string) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:UnsupportedFilterUiKind",
    { uiKind },
  );

export const unsupportedFilterPropertyType = (
  uiKind: string,
  property: string,
  propertyType: string,
  compatible: readonly string[],
) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:UnsupportedFilterPropertyType",
    { uiKind, property, propertyType, compatible: [...compatible] },
  );

export const invalidFilterValue = (
  property: string,
  uiKind: string,
  reason: string,
) =>
  new WorkshopError("INVALID_ARGUMENT", "Tellus:Workshop:InvalidFilterValue", {
    property,
    uiKind,
    reason,
  });

export const circularFilterReference = (cycle: string[]) =>
  new WorkshopError(
    "INVALID_ARGUMENT",
    "Tellus:Workshop:CircularFilterReference",
    { cycle },
  );

/**
 * Generic builder used by services that need to throw a Workshop error with
 * a custom name + parameters. The errorCode is inferred from the HTTP status,
 * which is the rule §0.1 requires.
 */
export function workshopError(opts: {
  errorName: string;
  status: number;
  message?: string;
  parameters?: Record<string, unknown>;
}): WorkshopError {
  // Map status -> ErrorCode
  const code: ErrorCode = (() => {
    switch (opts.status) {
      case 400:
        return "INVALID_ARGUMENT";
      case 403:
        return "PERMISSION_DENIED";
      case 404:
        return "NOT_FOUND";
      case 409:
        return "CONFLICT";
      case 412:
        return "FAILED_PRECONDITION";
      case 413:
        return "REQUEST_ENTITY_TOO_LARGE";
      case 503:
        return "UNAVAILABLE";
      case 504:
        return "TIMEOUT";
      default:
        return "INTERNAL";
    }
  })();
  return new WorkshopError(code, opts.errorName, opts.parameters ?? {});
}

// ---- B06 — OMS metadata facade --------------------------------------------

export const objectTypeNotFound = (
  ontologyRid: string,
  objectTypeId: string,
) =>
  new WorkshopError("NOT_FOUND", "Tellus:Workshop:ObjectTypeNotFound", {
    ontologyRid,
    objectTypeId,
  });

export const actionTypeNotFound = (
  ontologyRid: string,
  actionTypeId: string,
) =>
  new WorkshopError("NOT_FOUND", "Tellus:Workshop:ActionTypeNotFound", {
    ontologyRid,
    actionTypeId,
  });
