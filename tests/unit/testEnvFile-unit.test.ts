// ---------------------------------------------------------------------------
// Unit tests for tests/testEnvFile.ts — the file-backed fallback that
// replaced the baked-in "tellus123" / "tellus_ch_pw" literals in laneEnv.ts
// and vitest.osv2-serving.config.ts.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import {
  parseEnvFile,
  requiredTestSecret,
} from "../testEnvFile";

describe("parseEnvFile", () => {
  it("parses KEY=value pairs, skipping blanks and comments", () => {
    expect(
      parseEnvFile("# comment\n\nPGPASSWORD=tellus123\nCLICKHOUSE_PASSWORD=tellus_ch_pw\n"),
    ).toEqual({ PGPASSWORD: "tellus123", CLICKHOUSE_PASSWORD: "tellus_ch_pw" });
  });

  it("strips single and double quotes", () => {
    expect(parseEnvFile('A="quoted value"\nB=\'single\'\n')).toEqual({
      A: "quoted value",
      B: "single",
    });
  });

  it("ignores template placeholders with empty values", () => {
    expect(parseEnvFile("API_KEY=\nPRESENT=x\n")).toEqual({ PRESENT: "x" });
  });

  it("keeps '=' inside values (splits on the first one only)", () => {
    expect(parseEnvFile("TOKEN=abc==\n")).toEqual({ TOKEN: "abc==" });
  });
});

describe("requiredTestSecret", () => {
  it("prefers process.env over the file fallback (CI override wins)", () => {
    process.env.TELLUS_TEST_SECRET_PRECEDENCE_PROBE = "from-env";
    try {
      expect(requiredTestSecret("TELLUS_TEST_SECRET_PRECEDENCE_PROBE")).toBe("from-env");
    } finally {
      delete process.env.TELLUS_TEST_SECRET_PRECEDENCE_PROBE;
    }
  });

  it("resolves the committed lane defaults from .env.test.example when env is unset", () => {
    delete process.env.PGPASSWORD;
    delete process.env.CLICKHOUSE_PASSWORD;
    // .env.test may override these locally — either way they must resolve
    // to a non-empty string without any inline literal in test code.
    expect(requiredTestSecret("PGPASSWORD")).toMatch(/.+/);
    expect(requiredTestSecret("CLICKHOUSE_PASSWORD")).toMatch(/.+/);
  });

  it("fails fast with a clear message when no source has the key", () => {
    delete process.env.TELLUS_TEST_SECRET_DEFINITELY_ABSENT;
    expect(() => requiredTestSecret("TELLUS_TEST_SECRET_DEFINITELY_ABSENT")).toThrow(
      /TELLUS_TEST_SECRET_DEFINITELY_ABSENT is not set/,
    );
  });
});
