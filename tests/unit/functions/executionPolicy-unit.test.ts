// ---------------------------------------------------------------------------
// executionPolicy-unit.test.ts — trusted-author publish gate + legacy
// contract deprecation controls.
//
// These tests cover the REAL default mode (trusted-authors-only, env unset)
// — other lanes opt out via FUNCTION_EXECUTION_TRUST_MODE=open-development,
// which is why this file manipulates process.env directly and restores it.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import {
  executionPolicy,
  isLegacyContractExecutionAllowed,
  isPublishAuthorTrusted,
} from "../../../src/services/functions/executionPolicy";

const KEYS = [
  "FUNCTION_EXECUTION_TRUST_MODE",
  "FUNCTION_TRUSTED_AUTHOR_IDS",
  "FUNCTION_LEGACY_CONTRACT_DISABLED",
  "FUNCTION_LEGACY_CONTRACT_DEPRECATION_DATE",
] as const;

const saved = new Map<string, string | undefined>();
for (const key of KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of KEYS) {
    const original = saved.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("executionPolicy trust mode", () => {
  it("defaults to trusted-authors-only when unset", () => {
    delete process.env.FUNCTION_EXECUTION_TRUST_MODE;
    delete process.env.NODE_ENV;
    expect(executionPolicy().trustMode).toBe("trusted-authors-only");
  });

  it("an unknown mode value fails closed to trusted-authors-only", () => {
    delete process.env.NODE_ENV;
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "yolo";
    expect(executionPolicy().trustMode).toBe("trusted-authors-only");
  });

  it("open-development is honored outside production", () => {
    process.env.NODE_ENV = "test";
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "open-development";
    expect(executionPolicy().trustMode).toBe("open-development");
  });

  it("open-development is REFUSED in production (cannot silently open)", () => {
    process.env.NODE_ENV = "production";
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "open-development";
    expect(executionPolicy().trustMode).toBe("trusted-authors-only");
  });
});

describe("isPublishAuthorTrusted", () => {
  it("denies everyone when the allowlist is empty (fail closed)", () => {
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "trusted-authors-only";
    delete process.env.FUNCTION_TRUSTED_AUTHOR_IDS;
    expect(isPublishAuthorTrusted("user-1")).toBe(false);
    expect(isPublishAuthorTrusted("")).toBe(false);
    expect(isPublishAuthorTrusted(null)).toBe(false);
    expect(isPublishAuthorTrusted(undefined)).toBe(false);
  });

  it("admits exactly the allowlisted principals", () => {
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "trusted-authors-only";
    process.env.FUNCTION_TRUSTED_AUTHOR_IDS =
      " 9e821d8e-aaaa alice@example.com ,bobi ";
    expect(isPublishAuthorTrusted("9e821d8e-aaaa")).toBe(true);
    expect(isPublishAuthorTrusted("alice@example.com")).toBe(true);
    expect(isPublishAuthorTrusted("bobi")).toBe(true);
    expect(isPublishAuthorTrusted("mallory")).toBe(false);
  });

  it("open-development admits any principal", () => {
    process.env.NODE_ENV = "test";
    process.env.FUNCTION_EXECUTION_TRUST_MODE = "open-development";
    delete process.env.FUNCTION_TRUSTED_AUTHOR_IDS;
    expect(isPublishAuthorTrusted("mallory")).toBe(true);
    expect(isPublishAuthorTrusted(null)).toBe(true);
  });
});

describe("legacy contract deprecation controls", () => {
  it("legacy executions are allowed by default", () => {
    delete process.env.FUNCTION_LEGACY_CONTRACT_DISABLED;
    expect(isLegacyContractExecutionAllowed()).toBe(true);
  });

  it("FUNCTION_LEGACY_CONTRACT_DISABLED=true blocks legacy executions only", () => {
    process.env.FUNCTION_LEGACY_CONTRACT_DISABLED = "true";
    expect(isLegacyContractExecutionAllowed()).toBe(false);
    // The positional contract is never affected by the switch.
    expect(isPublishAuthorTrusted).toBeTypeOf("function");
  });

  it("parses a valid deprecation date and rejects malformed ones", () => {
    process.env.FUNCTION_LEGACY_CONTRACT_DEPRECATION_DATE = "2026-12-31";
    expect(executionPolicy().legacyDeprecationDate).toBe("2026-12-31");
    process.env.FUNCTION_LEGACY_CONTRACT_DEPRECATION_DATE = "31/12/2026";
    expect(executionPolicy().legacyDeprecationDate).toBeNull();
  });
});
