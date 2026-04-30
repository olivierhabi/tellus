// ---------------------------------------------------------------------------
// F-P4-23 / F-P4-24 / F-P4-25 / F-P4-26 — negative tests for the
// fail-closed env-var reader. These tests would FAIL against the pre-fix
// commit because the old code silently returned 'tellus123' / 'minioadmin'
// / 'tellus' instead of throwing when the env var was absent.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  envWithDefault,
  requireEnv,
  requireSecret,
  assertRequiredEnv,
  MissingEnvError,
} from "../../../src/utils/requireEnv";

describe("requireEnv fail-closed policy (F-P4-23/24/25/26)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.TELLUS_TEST_SECRET;
    delete process.env.TELLUS_TEST_CONFIG;
    delete process.env.TELLUS_TEST_MISSING_A;
    delete process.env.TELLUS_TEST_MISSING_B;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("requireEnv throws MissingEnvError when unset", () => {
    expect(() => requireEnv("TELLUS_TEST_SECRET")).toThrow(MissingEnvError);
    expect(() => requireEnv("TELLUS_TEST_SECRET")).toThrow(/TELLUS_TEST_SECRET/);
  });

  it("requireEnv throws when set to empty or whitespace-only", () => {
    process.env.TELLUS_TEST_SECRET = "";
    expect(() => requireEnv("TELLUS_TEST_SECRET")).toThrow(MissingEnvError);
    process.env.TELLUS_TEST_SECRET = "   ";
    expect(() => requireEnv("TELLUS_TEST_SECRET")).toThrow(MissingEnvError);
  });

  it("requireEnv returns the value when set", () => {
    process.env.TELLUS_TEST_SECRET = "hunter2";
    expect(requireEnv("TELLUS_TEST_SECRET")).toBe("hunter2");
  });

  it("requireSecret has identical semantics to requireEnv", () => {
    expect(() => requireSecret("TELLUS_TEST_SECRET")).toThrow(MissingEnvError);
    process.env.TELLUS_TEST_SECRET = "rotate-me";
    expect(requireSecret("TELLUS_TEST_SECRET")).toBe("rotate-me");
  });

  it("envWithDefault returns the default when unset", () => {
    expect(envWithDefault("TELLUS_TEST_CONFIG", "localhost")).toBe("localhost");
  });

  it("envWithDefault returns the value when set", () => {
    process.env.TELLUS_TEST_CONFIG = "pg.prod.internal";
    expect(envWithDefault("TELLUS_TEST_CONFIG", "localhost")).toBe(
      "pg.prod.internal"
    );
  });

  it("assertRequiredEnv collects ALL missing names into a single error", () => {
    try {
      assertRequiredEnv(["TELLUS_TEST_MISSING_A", "TELLUS_TEST_MISSING_B"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvError);
      expect((err as MissingEnvError).message).toMatch(/TELLUS_TEST_MISSING_A/);
      expect((err as MissingEnvError).message).toMatch(/TELLUS_TEST_MISSING_B/);
    }
  });

  it("assertRequiredEnv passes when all env vars are set", () => {
    process.env.TELLUS_TEST_MISSING_A = "a";
    process.env.TELLUS_TEST_MISSING_B = "b";
    expect(() =>
      assertRequiredEnv(["TELLUS_TEST_MISSING_A", "TELLUS_TEST_MISSING_B"])
    ).not.toThrow();
  });

  it("MissingEnvError carries the env-var name for telemetry", () => {
    try {
      requireEnv("TELLUS_NEVER_SET");
    } catch (err) {
      expect((err as MissingEnvError).envVar).toBe("TELLUS_NEVER_SET");
      expect((err as MissingEnvError).code).toBe("MISSING_ENV");
    }
  });

  // Negative test asserting the behaviour contract that protects against
  // the regression of the well-known-default pattern.
  it("does NOT silently return 'tellus123' / 'minioadmin' / 'tellus'", () => {
    delete process.env.PGPASSWORD;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.KEYCLOAK_REALM;
    expect(() => requireSecret("PGPASSWORD")).toThrow(MissingEnvError);
    expect(() => requireSecret("S3_ACCESS_KEY_ID")).toThrow(MissingEnvError);
    expect(() => requireSecret("S3_SECRET_ACCESS_KEY")).toThrow(MissingEnvError);
    // Note: Keycloak realm uses `getKeycloakRealm` (env-dependent), tested separately.
  });
});
