// ---------------------------------------------------------------------------
// Action Semantics v2 — unit tests for the semantics matrix + error contract.
// Pure: no DB, no IO.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import {
  validateActionSemantics,
  resolveSemanticsFromRow,
  V1_DEFAULT_SEMANTICS,
  V2_DEFAULT_SEMANTICS,
  VALID_SEMANTICS_COMBINATIONS,
  behaviourMatrix,
  SUPPORTED_SEMANTICS_VERSIONS,
} from "../../../src/actions/actionSemantics";
import {
  httpStatusForActionError,
  buildBlockingSummary,
  MAX_BLOCKING_SAMPLE,
  isDomainValidationError,
  isConcurrencyFailure,
  deleteBlockedByRelationshipsError,
  sameInvocationReferenceForbiddenError,
  unsupportedSemanticsVersionError,
  invalidObjectReferenceError,
  invalidPrimaryKeyError,
  objectTypeMismatchError,
  objectNotFoundError,
  objectAlreadyExistsError,
  duplicatePrimaryKeyError,
  danglingRelationshipError,
  finalStateInvalidError,
  concurrencyConflictError,
  redactMeta,
  ALL_ACTION_ERROR_CODES,
  type ActionErrorCode,
} from "../../../src/actions/actionErrors";

describe("actionSemantics — validateActionSemantics", () => {
  it("accepts the canonical version-1 triple", () => {
    expect(validateActionSemantics(V1_DEFAULT_SEMANTICS).valid).toBe(true);
  });
  it("accepts the canonical version-2 triple", () => {
    expect(validateActionSemantics(V2_DEFAULT_SEMANTICS).valid).toBe(true);
  });
  it("rejects version 2 with legacy_unchecked", () => {
    const r = validateActionSemantics({
      semanticsVersion: 2,
      executionMode: "declarative",
      deletePolicy: "legacy_unchecked",
    });
    expect(r.valid).toBe(false);
    expect(r.error!.code).toBe("INCOMPATIBLE_ACTION_SEMANTICS");
  });
  it("rejects version 1 with restrict", () => {
    const r = validateActionSemantics({
      semanticsVersion: 1,
      executionMode: "declarative",
      deletePolicy: "restrict",
    });
    expect(r.valid).toBe(false);
    expect(r.error!.code).toBe("INCOMPATIBLE_ACTION_SEMANTICS");
  });
  it("accepts function execution mode for version 2", () => {
    const r = validateActionSemantics({
      semanticsVersion: 2,
      executionMode: "function",
      deletePolicy: "restrict",
    });
    expect(r.valid).toBe(true);
  });
  it("rejects an unknown future version (fail closed)", () => {
    const r = validateActionSemantics({
      semanticsVersion: 3 as any,
      executionMode: "declarative",
      deletePolicy: "restrict",
    });
    expect(r.valid).toBe(false);
    expect(r.error!.code).toBe("UNSUPPORTED_SEMANTICS_VERSION");
  });
  it("rejects an unsupported delete policy (detach) not persisted yet", () => {
    const r = validateActionSemantics({
      semanticsVersion: 2,
      executionMode: "declarative",
      deletePolicy: "detach" as any,
    });
    expect(r.valid).toBe(false);
    expect(r.error!.code).toBe("INVALID_DELETE_POLICY");
  });
  it("validates declarative and function combinations for both versions", () => {
    expect(VALID_SEMANTICS_COMBINATIONS).toHaveLength(4);
  });
  it("treats partial validation as valid until the full triple is given", () => {
    expect(validateActionSemantics({ semanticsVersion: 1 }).valid).toBe(true);
    expect(
      validateActionSemantics({ semanticsVersion: 2, deletePolicy: "restrict" })
        .valid,
    ).toBe(true);
  });
});

describe("actionSemantics — resolveSemanticsFromRow (Stage B fallback)", () => {
  it("falls back to v1 defaults when columns are NULL", () => {
    expect(
      resolveSemanticsFromRow({
        semantics_version: null,
        execution_mode: null,
        delete_policy: null,
      }),
    ).toEqual(V1_DEFAULT_SEMANTICS);
  });
  it("falls back to v1 defaults when columns are undefined", () => {
    expect(resolveSemanticsFromRow({})).toEqual(V1_DEFAULT_SEMANTICS);
  });
  it("returns persisted explicit version 2 values", () => {
    expect(
      resolveSemanticsFromRow({
        semantics_version: 2,
        execution_mode: "declarative",
        delete_policy: "restrict",
      }),
    ).toEqual(V2_DEFAULT_SEMANTICS);
  });
  it("default-fills missing mode/policy for an explicit version", () => {
    expect(
      resolveSemanticsFromRow({ semantics_version: 1 }),
    ).toEqual(V1_DEFAULT_SEMANTICS);
    expect(
      resolveSemanticsFromRow({ semantics_version: 2 }),
    ).toEqual(V2_DEFAULT_SEMANTICS);
  });
});

describe("actionSemantics — behaviourMatrix", () => {
  it("new UI-created action types default to version 2", () => {
    expect(behaviourMatrix.newActionTypeDefaultVersion).toBe(2);
  });
  it("string-as-object-reference supported only on v1", () => {
    expect(behaviourMatrix.stringAsObjectReference(1)).toBe(true);
    expect(behaviourMatrix.stringAsObjectReference(2)).toBe(false);
  });
  it("typed object_reference required for v2 modify/delete/modify-or-create", () => {
    expect(behaviourMatrix.typedObjectReferenceRequired(2, "deleteObject")).toBe(true);
    expect(behaviourMatrix.typedObjectReferenceRequired(2, "modifyObject")).toBe(true);
    expect(behaviourMatrix.typedObjectReferenceRequired(1, "deleteObject")).toBe(false);
  });
  it("create-then-modify/delete only on v1", () => {
    expect(behaviourMatrix.createThenModify(1)).toBe(true);
    expect(behaviourMatrix.createThenModify(2)).toBe(false);
    expect(behaviourMatrix.createThenDelete(1)).toBe(true);
    expect(behaviourMatrix.createThenDelete(2)).toBe(false);
  });
  it("delete restrict only on v2", () => {
    expect(behaviourMatrix.deleteRestrict(1)).toBe(false);
    expect(behaviourMatrix.deleteRestrict(2)).toBe(true);
  });
  it("function execution supports immutable published bindings", () => {
    expect(behaviourMatrix.functionExecutionSupported(1)).toBe(true);
    expect(behaviourMatrix.functionExecutionSupported(2)).toBe(true);
  });
  it("SUPPORTED_SEMANTICS_VERSIONS = {1,2}", () => {
    expect(SUPPORTED_SEMANTICS_VERSIONS.has(1)).toBe(true);
    expect(SUPPORTED_SEMANTICS_VERSIONS.has(2)).toBe(true);
    expect(SUPPORTED_SEMANTICS_VERSIONS.has(3 as any)).toBe(false);
  });
});

describe("actionErrors — HTTP status mapping", () => {
  it("maps concurrency conflict to 409", () => {
    expect(httpStatusForActionError("transaction", "CONCURRENCY_CONFLICT")).toBe(409);
  });
  it("maps object-not-found to 404", () => {
    expect(httpStatusForActionError("compilation", "OBJECT_NOT_FOUND")).toBe(404);
  });
  it("maps unsupported semantics to 422", () => {
    expect(
      httpStatusForActionError("definition", "UNSUPPORTED_SEMANTICS_VERSION"),
    ).toBe(422);
  });
  it("maps definition-stage domain errors to 400", () => {
    expect(
      httpStatusForActionError("definition", "INVALID_OBJECT_REFERENCE"),
    ).toBe(400);
    expect(
      httpStatusForActionError("invocation", "INVALID_PRIMARY_KEY"),
    ).toBe(400);
  });
  it("maps transaction-stage final-state to 422", () => {
    expect(
      httpStatusForActionError("transaction", "DELETE_BLOCKED_BY_RELATIONSHIPS"),
    ).toBe(422);
    expect(httpStatusForActionError("transaction", "FINAL_STATE_INVALID")).toBe(422);
  });
  it("maps DEADLOCK_RETRY_EXHAUSTED to 500", () => {
    expect(
      httpStatusForActionError("transaction", "DEADLOCK_RETRY_EXHAUSTED"),
    ).toBe(500);
  });
});

describe("actionErrors — factories produce stable shapes", () => {
  it("produces a retryable concurrency conflict", () => {
    const e = concurrencyConflictError("boom");
    expect(e.code).toBe("CONCURRENCY_CONFLICT");
    expect(e.retryable).toBe(true);
    expect(e.stage).toBe("transaction");
  });
  it("same-invocation reference forbidden is non-retryable and carries objectType", () => {
    const e = sameInvocationReferenceForbiddenError("rules[1].objectReference", {
      objectType: "Customer",
      primaryKey: "c123",
    });
    expect(e.code).toBe("SAME_INVOCATION_REFERENCE_FORBIDDEN");
    expect(e.retryable).toBe(false);
    expect(e.meta!.objectType).toBe("Customer");
    expect(e.meta!.primaryKey).toBeUndefined();
  });
  it("delete blocked embeds a bounded summary, never the raw PK", () => {
    const e = deleteBlockedByRelationshipsError("rules[0].objectReference", {
      total: 100,
      inboundCount: 40,
      outboundCount: 60,
      byLinkType: [{ linkType: "owns", inbound: 40, outbound: 60 }],
      sample: [],
      sampleTruncated: true,
    });
    expect(e.code).toBe("DELETE_BLOCKED_BY_RELATIONSHIPS");
    expect(e.meta!.total).toBe(100);
    expect(e.meta!.sampleTruncated).toBe(true);
  });
  it("all factory errors carry a code in the stable code set", () => {
    const samples = [
      unsupportedSemanticsVersionError(3),
      invalidObjectReferenceError("parameters.x", "bad"),
      invalidPrimaryKeyError("parameters.x", "v", "string", "coercion failed"),
      objectTypeMismatchError("rules[0]", "A", "B"),
      objectNotFoundError("rules[0]", "A", "1"),
      objectAlreadyExistsError("rules[0]", "A", "1"),
      duplicatePrimaryKeyError("rules[0]", "A", "1"),
      danglingRelationshipError("rules[0]", {
        linkType: "l",
        sourceObjectType: "A",
        targetObjectType: "B",
      }),
      finalStateInvalidError("nope"),
    ];
    for (const err of samples) {
      expect(ALL_ACTION_ERROR_CODES.has(err.code as ActionErrorCode)).toBe(true);
    }
  });
});

describe("actionErrors — blocking summary bounds", () => {
  it("builds counts exactly and truncates sample at MAX_BLOCKING_SAMPLE", () => {
    const raw = Array.from({ length: MAX_BLOCKING_SAMPLE + 10 }, (_, i) => ({
      linkType: "l",
      sourceObjectType: "A",
      sourcePrimaryKey: String(i),
      targetObjectType: "B",
      targetPrimaryKey: "t",
      direction: "outbound" as const,
    }));
    const s = buildBlockingSummary(raw);
    expect(s.total).toBe(MAX_BLOCKING_SAMPLE + 10);
    expect(s.outboundCount).toBe(MAX_BLOCKING_SAMPLE + 10);
    expect(s.inboundCount).toBe(0);
    expect(s.sample.length).toBe(MAX_BLOCKING_SAMPLE);
    expect(s.sampleTruncated).toBe(true);
  });
  it("aggregates by linktype correctly", () => {
    const s = buildBlockingSummary([
      { linkType: "a", sourceObjectType: "A", sourcePrimaryKey: "1", targetObjectType: "B", targetPrimaryKey: "2", direction: "inbound" },
      { linkType: "a", sourceObjectType: "A", sourcePrimaryKey: "3", targetObjectType: "B", targetPrimaryKey: "4", direction: "outbound" },
    ]);
    expect(s.byLinkType).toEqual([{ linkType: "a", inbound: 1, outbound: 1 }]);
    expect(s.sampleTruncated).toBe(false);
  });
});

describe("actionErrors — redaction", () => {
  it("strips primaryKey / value / parameters keys", () => {
    const out = redactMeta({
      primaryKey: "secret",
      value: "secret",
      parameters: { a: 1 },
      count: 42,
      ok: true,
      kind: "x",
      arr: [1, 2, 3],
    })!;
    expect(out.primaryKey).toBeUndefined();
    expect(out.value).toBeUndefined();
    expect(out.parameters).toBeUndefined();
    expect(out.count).toBe(42);
    expect(out.arr).toBe(3);
    expect(out.kind).toBe("x");
  });
  it("returns undefined for no input", () => {
    expect(redactMeta(undefined)).toBeUndefined();
  });
});

describe("actionErrors — code classifiers", () => {
  it("isDomainValidationError distinguishes concurrency errors", () => {
    expect(isDomainValidationError("CONCURRENCY_CONFLICT")).toBe(false);
    expect(isDomainValidationError("OBJECT_NOT_FOUND")).toBe(true);
  });
  it("isConcurrencyFailure matches only the concurrency code", () => {
    expect(isConcurrencyFailure("CONCURRENCY_CONFLICT")).toBe(true);
    expect(isConcurrencyFailure("OBJECT_NOT_FOUND")).toBe(false);
  });
});
