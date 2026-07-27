import { afterEach, describe, expect, it } from "vitest";
import {
  getActionSemanticsExecutionAvailability,
  shouldEnforceSemantics,
} from "../../../src/actions/actionSemanticsFlags";
import {
  OntologyError,
  STANDARD_ERROR_CODES,
} from "../../../src/utils/queryErrors";

const FLAG_NAMES = [
  "ACTION_SEMANTICS_V2_ENABLED",
  "ACTION_SEMANTICS_V2_PROJECTION_READY",
  "ACTION_SEMANTICS_V2_CREATION_ENABLED",
  "ACTION_SEMANTICS_V2_KILL_SWITCH",
] as const;

const originalFlags = Object.fromEntries(
  FLAG_NAMES.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of FLAG_NAMES) {
    const original = originalFlags[name];
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
});

describe("action semantics execution availability", () => {
  it("always permits version 1", () => {
    expect(getActionSemanticsExecutionAvailability(1)).toEqual({
      available: true,
    });
    expect(shouldEnforceSemantics(1)).toBe(true);
  });

  it("fails closed when version-2 execution is disabled", () => {
    delete process.env.ACTION_SEMANTICS_V2_ENABLED;
    process.env.ACTION_SEMANTICS_V2_PROJECTION_READY = "true";

    expect(getActionSemanticsExecutionAvailability(2)).toMatchObject({
      available: false,
      code: "UNSUPPORTED_SEMANTICS_VERSION",
      details: {
        reason: "execution_disabled",
        executionEnabled: false,
        projectionReady: true,
      },
    });
  });

  it("fails closed until the relationship projection is verified", () => {
    process.env.ACTION_SEMANTICS_V2_ENABLED = "true";
    delete process.env.ACTION_SEMANTICS_V2_PROJECTION_READY;

    expect(getActionSemanticsExecutionAvailability(2)).toMatchObject({
      available: false,
      code: "UNSUPPORTED_SEMANTICS_VERSION",
      details: {
        reason: "projection_not_ready",
        executionEnabled: true,
        projectionReady: false,
      },
    });
  });

  it("permits version 2 only when execution and projection are ready", () => {
    process.env.ACTION_SEMANTICS_V2_ENABLED = "true";
    process.env.ACTION_SEMANTICS_V2_PROJECTION_READY = "true";

    expect(getActionSemanticsExecutionAvailability(2)).toEqual({
      available: true,
    });
    expect(shouldEnforceSemantics(2)).toBe(true);
  });

  it("lets the emergency kill switch override ready flags", () => {
    process.env.ACTION_SEMANTICS_V2_ENABLED = "true";
    process.env.ACTION_SEMANTICS_V2_PROJECTION_READY = "true";
    process.env.ACTION_SEMANTICS_V2_KILL_SWITCH = "true";

    expect(getActionSemanticsExecutionAvailability(2)).toMatchObject({
      available: false,
      details: {
        reason: "kill_switch_enabled",
        killSwitchEnabled: true,
      },
    });
  });

  it("rejects unknown future versions", () => {
    expect(getActionSemanticsExecutionAvailability(3)).toMatchObject({
      available: false,
      code: "UNSUPPORTED_SEMANTICS_VERSION",
      details: { reason: "unsupported_version", semanticsVersion: 3 },
    });
  });
});

describe("action semantics public error contract", () => {
  it("registers unsupported semantics as a typed 422 error", () => {
    expect(STANDARD_ERROR_CODES.UNSUPPORTED_SEMANTICS_VERSION).toEqual({
      status: 422,
      name: "UnsupportedActionSemanticsVersionError",
    });

    const error = new OntologyError(
      "Version-2 action execution is unavailable.",
      "UNSUPPORTED_SEMANTICS_VERSION",
    );
    expect(error.toResponse()).toMatchObject({
      errorCode: "UNSUPPORTED_SEMANTICS_VERSION",
      errorName: "UnsupportedActionSemanticsVersionError",
      statusCode: 422,
    });
  });
});
