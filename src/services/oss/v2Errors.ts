// ---------------------------------------------------------------------------
// V2 error translation (Phases 9/11) — single mapping layer.
//
// v1 error codes are preserved untouched. This layer translates
// internal errors into the v2 envelope:
//
//   { errorCode, errorName, errorInstanceId, parameters }
//
// Error names follow the verified public convention
// (PascalCase). Where the public spec does not pin a name we use
// the closest documented analogue and record it in the
// conformance doc.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

export interface V2ErrorBody {
  errorCode: string;
  errorName: string;
  errorInstanceId: string;
  parameters: Record<string, unknown>;
}

interface Mapping {
  status: number;
  errorCode: string;
  errorName: string;
}

/** Internal errorName/code → v2 envelope mapping. */
const ERROR_MAP: Record<string, Mapping> = {
  // Request validation
  InvalidLoadObjectSetRequest: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidLoadObjectSetRequest" },
  InvalidAggregateObjectSetRequest: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidAggregateObjectSetRequest" },
  InvalidApplyActionRequest: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidApplyActionRequest" },
  InvalidObjectSet: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidObjectSet" },
  ObjectSetTooDeep: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "ObjectSetTooDeep" },
  ObjectSetTooComplex: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "ObjectSetTooComplex" },
  ObjectSetTooLarge: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "ObjectSetTooLarge" },
  InvalidPageToken: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidPageToken" },
  InvalidPageSize: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidPageSize" },
  PreviewRequired: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "PreviewRequired" },
  UnsupportedFilter: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "UnsupportedFilter" },
  InvalidAggregationDurationValue: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidAggregationDurationValue" },
  InvalidTimeUnit: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidTimeUnit" },
  InvalidTimeZone: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidTimeZone" },
  InvalidRelativeTimeUnit: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidRelativeTimeUnit" },
  UnsupportedDerivedProperty: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "UnsupportedDerivedProperty" },
  UnsupportedObjectSetFeature: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "UnsupportedObjectSetFeature" },
  // Not-found family
  ObjectTypeNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "ObjectTypeNotFound" },
  ObjectNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "ObjectNotFound" },
  ObjectSetNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "ObjectSetNotFound" },
  LinkTypeNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "LinkTypeNotFound" },
  InterfaceLinkTypeNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "InterfaceLinkTypeNotFound" },
  InterfaceTypeNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "InterfaceTypeNotFound" },
  PropertyNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "PropertyNotFound" },
  OntologyNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "OntologyNotFound" },
  ActionTypeNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "ActionTypeNotFound" },
  ActionFailed: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "ActionFailed" },
  // Consistency / accuracy
  AggregationAccuracyNotSupported: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "AggregationAccuracyNotSupported" },
  ConsistentSnapshotError: { status: 409, errorCode: "CONFLICT", errorName: "ConsistentSnapshotError" },
  OntologyTransactionBranchMismatch: { status: 409, errorCode: "CONFLICT", errorName: "OntologyTransactionBranchMismatch" },
  OntologyScenarioBranchMismatch: { status: 409, errorCode: "CONFLICT", errorName: "OntologyScenarioBranchMismatch" },
  OntologyTransactionInvalidState: { status: 409, errorCode: "CONFLICT", errorName: "OntologyTransactionInvalidState" },
  OntologyScenarioInvalidState: { status: 409, errorCode: "CONFLICT", errorName: "OntologyScenarioInvalidState" },
  OntologyReadContextNotWritable: { status: 409, errorCode: "CONFLICT", errorName: "OntologyReadContextNotWritable" },
  OntologyTransactionExpired: { status: 410, errorCode: "NOT_FOUND", errorName: "OntologyTransactionExpired" },
  OntologyScenarioExpired: { status: 410, errorCode: "NOT_FOUND", errorName: "OntologyScenarioExpired" },
  // Capability
  NearestNeighborsTextNotConfigured: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "NearestNeighborsTextNotConfigured" },
  InvalidNearestNeighborsProperty: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidNearestNeighborsProperty" },
  NearestNeighborsDimensionMismatch: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "NearestNeighborsDimensionMismatch" },
  EmbeddingProviderNotConfigured: { status: 503, errorCode: "INTERNAL", errorName: "EmbeddingProviderNotConfigured" },
  EmbeddingProviderUnavailable: { status: 503, errorCode: "INTERNAL", errorName: "EmbeddingProviderUnavailable" },
  EmbeddingProviderTimeout: { status: 504, errorCode: "INTERNAL", errorName: "EmbeddingProviderTimeout" },
  EmbeddingProviderRateLimited: { status: 429, errorCode: "RATE_LIMITED", errorName: "EmbeddingProviderRateLimited" },
  SearchBackendUnavailable: { status: 503, errorCode: "INTERNAL", errorName: "SearchBackendUnavailable" },
  TemporaryObjectSetStoreUnavailable: { status: 503, errorCode: "INTERNAL", errorName: "TemporaryObjectSetStoreUnavailable" },
  SubscriptionLimitExceeded: { status: 429, errorCode: "RATE_LIMITED", errorName: "SubscriptionLimitExceeded" },
  SubscriptionCursorExpired: { status: 410, errorCode: "NOT_FOUND", errorName: "SubscriptionCursorExpired" },
  MethodInputUnbound: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "MethodInputUnbound" },
  CircularObjectSetReference: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "CircularObjectSetReference" },
  StaticObjectSetUnsupported: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "StaticObjectSetUnsupported" },
  SearchAroundUnsupported: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "SearchAroundUnsupported" },
  ObjectSetReferenceUnsupported: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "ObjectSetReferenceUnsupported" },
  InterfaceResolutionUnsupported: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InterfaceResolutionUnsupported" },
  StoredObjectSetInvalid: { status: 500, errorCode: "INTERNAL", errorName: "StoredObjectSetInvalid" },
  InvalidObjectTypeMetadata: { status: 500, errorCode: "INTERNAL", errorName: "InvalidObjectTypeMetadata" },
  InvalidActionTypeMetadata: { status: 500, errorCode: "INTERNAL", errorName: "InvalidActionTypeMetadata" },
  FolderNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "FolderNotFound" },
  OntologyTransactionNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "OntologyTransactionNotFound" },
  OntologyScenarioNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "OntologyScenarioNotFound" },
  SubscriptionNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "SubscriptionNotFound" },
  PropertiesNotFound: { status: 404, errorCode: "NOT_FOUND", errorName: "PropertiesNotFound" },
};

/** Legacy v1/internal code → v2 name (route-level translation). */
const LEGACY_CODE_MAP: Record<string, Mapping> = {
  OBJECT_TYPE_NOT_FOUND: ERROR_MAP.ObjectTypeNotFound!,
  OBJECT_NOT_FOUND: ERROR_MAP.ObjectNotFound!,
  PROPERTY_NOT_FOUND: ERROR_MAP.PropertyNotFound!,
  ONTOLOGY_NOT_FOUND: ERROR_MAP.OntologyNotFound!,
  QUERY_VALIDATION_ERROR: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidSearchQuery" },
  INCOMPATIBLE_FILTER: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "IncompatibleFilter" },
  UNSUPPORTED_FILTER: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "UnsupportedFilter" },
  INVALID_PAGE_TOKEN: ERROR_MAP.InvalidPageToken!,
  INVALID_ARGUMENT: { status: 400, errorCode: "INVALID_ARGUMENT", errorName: "InvalidRequest" },
  OPENSEARCH_ERROR: { status: 503, errorCode: "INTERNAL", errorName: "SearchBackendUnavailable" },
};

export function toV2Error(err: unknown): { status: number; body: V2ErrorBody } {
  const anyErr = err as {
    errorName?: string;
    code?: string;
    message?: string;
    parameters?: Record<string, unknown>;
    statusCode?: number;
  };
  const extracted = anyErr?.message ? extractName(anyErr.message) : null;
  const mapping: Mapping | undefined =
    (anyErr?.errorName ? ERROR_MAP[anyErr.errorName] : undefined) ??
    (anyErr?.code ? LEGACY_CODE_MAP[anyErr.code] : undefined) ??
    (extracted ? ERROR_MAP[extracted] : undefined);
  const m: Mapping =
    mapping ??
    (anyErr?.errorName && anyErr.statusCode
      ? {
          status: anyErr.statusCode,
          errorCode:
            anyErr.statusCode === 404 || anyErr.statusCode === 410
              ? "NOT_FOUND"
              : anyErr.statusCode === 409
                ? "CONFLICT"
                : anyErr.statusCode === 429
                  ? "RATE_LIMITED"
                  : anyErr.statusCode >= 500
                    ? "INTERNAL"
                    : "INVALID_ARGUMENT",
          errorName: anyErr.errorName,
        }
      : {
          status: 500,
          errorCode: "INTERNAL",
          errorName: "InternalError",
        });
  return {
    status: m.status,
    body: {
      errorCode: m.errorCode,
      errorName: m.errorName,
      errorInstanceId: randomUUID(),
      parameters: {
        ...(anyErr?.parameters ?? {}),
        ...(m.errorName === "InternalError"
          ? {}
          : { reason: anyErr?.message ?? "unknown" }),
      },
    },
  };
}

/** "INVALID_ARGUMENT: foo" / "Name: message" prefixed errors. */
function extractName(message: string): string | null {
  const m = /^([A-Za-z][A-Za-z0-9]*):/.exec(message);
  return m ? m[1]! : null;
}
