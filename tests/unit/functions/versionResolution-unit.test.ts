// ---------------------------------------------------------------------------
// versionResolution — semantic-version range resolution for automatic
// upgrades: range floor, major boundary, prerelease exclusion, signature
// compatibility, contract equality.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { resolveCompatibleUpgrade } from "../../../src/services/functions/versionResolution";
import {
  TYPESCRIPT_V2_POSITIONAL_V2,
  LEGACY_OBJECT_ENVELOPE_V1,
} from "../../../src/services/functions/canonicalSignature";

const SIGNATURE = {
  parameters: [{ name: "name", type: "string", optional: false }],
  output: "string",
};
const SIGNATURE_WITH_OPTIONAL = {
  parameters: [
    { name: "name", type: "string", optional: false },
    { name: "punctuation", type: "string", optional: true },
  ],
  output: "string",
};
const SIGNATURE_RENAMED = {
  parameters: [{ name: "marker", type: "string", optional: false }],
  output: "string",
};

function candidate(semver: string, signature: unknown = SIGNATURE) {
  return {
    semver,
    signature,
    invocationContract: TYPESCRIPT_V2_POSITIONAL_V2,
  };
}

describe("resolveCompatibleUpgrade", () => {
  it("pins 1.4.2 resolves the highest stable < 2.0.0", () => {
    const result = resolveCompatibleUpgrade({
      pinnedSemver: "1.4.2",
      pinnedSignature: SIGNATURE,
      pinnedContract: TYPESCRIPT_V2_POSITIONAL_V2,
      candidates: [
        candidate("1.4.2"),
        candidate("1.9.0"),
        candidate("1.4.9"),
        candidate("2.0.0"),
        candidate("3.1.0"),
      ],
    });
    expect(result?.semver).toBe("1.9.0");
  });

  it("never crosses the major version", () => {
    const result = resolveCompatibleUpgrade({
      pinnedSemver: "1.0.0",
      pinnedSignature: SIGNATURE,
      pinnedContract: TYPESCRIPT_V2_POSITIONAL_V2,
      candidates: [candidate("2.0.0")],
    });
    expect(result).toBeNull();
  });

  it("never auto-upgrades from versions below 1.0.0", () => {
    const result = resolveCompatibleUpgrade({
      pinnedSemver: "0.9.9",
      pinnedSignature: SIGNATURE,
      pinnedContract: TYPESCRIPT_V2_POSITIONAL_V2,
      candidates: [candidate("0.10.0"), candidate("1.0.0")],
    });
    expect(result).toBeNull();
  });

  it("excludes prereleases", () => {
    const result = resolveCompatibleUpgrade({
      pinnedSemver: "1.4.2",
      pinnedSignature: SIGNATURE,
      pinnedContract: TYPESCRIPT_V2_POSITIONAL_V2,
      candidates: [candidate("1.5.0-rc.1"), candidate("1.4.3")],
    });
    expect(result?.semver).toBe("1.4.3");
  });

  it("rejects versions at or below the pin", () => {
    expect(
      resolveCompatibleUpgrade({
        pinnedSemver: "1.4.2",
        pinnedSignature: SIGNATURE,
        pinnedContract: TYPESCRIPT_V2_POSITIONAL_V2,
        candidates: [candidate("1.4.2"), candidate("1.4.1")],
      }),
    ).toBeNull();
  });

  it("allows compatible changes (appended optional parameter)", () => {
    const result = resolveCompatibleUpgrade({
      pinnedSemver: "1.0.0",
      pinnedSignature: SIGNATURE,
      pinnedContract: TYPESCRIPT_V2_POSITIONAL_V2,
      candidates: [candidate("1.1.0", SIGNATURE_WITH_OPTIONAL)],
    });
    expect(result?.semver).toBe("1.1.0");
  });

  it("rejects signature-incompatible candidates and falls through to older compatible ones", () => {
    const result = resolveCompatibleUpgrade({
      pinnedSemver: "1.0.0",
      pinnedSignature: SIGNATURE,
      pinnedContract: TYPESCRIPT_V2_POSITIONAL_V2,
      candidates: [
        candidate("1.2.0", SIGNATURE_RENAMED), // incompatible — skipped
        candidate("1.1.0", SIGNATURE), // compatible — chosen
      ],
    });
    expect(result?.semver).toBe("1.1.0");
  });

  it("never crosses the invocation contract", () => {
    const result = resolveCompatibleUpgrade({
      pinnedSemver: "1.0.0",
      pinnedSignature: SIGNATURE,
      pinnedContract: TYPESCRIPT_V2_POSITIONAL_V2,
      candidates: [
        {
          semver: "1.1.0",
          signature: SIGNATURE,
          invocationContract: LEGACY_OBJECT_ENVELOPE_V1,
        },
      ],
    });
    expect(result).toBeNull();
  });
});
