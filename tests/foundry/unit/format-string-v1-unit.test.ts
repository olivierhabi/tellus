// ---------------------------------------------------------------------------
// Format string (Palantir formatStringV1) — printf mini-language parity.
//
// The doc examples are the contract: https://www.palantir.com/docs/foundry/
// pb-functions-expression/formatStringV1 — %s, %d, %+.4f, and the null case
// ("Values that are null format as the literal text null"). These tests pin
// the exact outputs the docs show, plus the lenient behaviours the preview
// engine relies on (missing args → "null", %% escape).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { formatStringValue } from "../../../src/services/transformService";

describe("formatStringValue (formatStringV1)", () => {
  it("reproduces the documented base case (Hello %s)", () => {
    expect(formatStringValue("Hello %s, my name is %s", ["Alice", "Bob"])).toBe(
      "Hello Alice, my name is Bob",
    );
  });

  it("reproduces the documented integer case (%d)", () => {
    expect(formatStringValue("number = %d", [4])).toBe("number = 4");
  });

  it("reproduces the documented float case (%+.4f)", () => {
    expect(formatStringValue("e = %+.4f", [2.718281828459045])).toBe("e = +2.7183");
  });

  it("reproduces the documented null case (nulls format as literal 'null')", () => {
    expect(formatStringValue("Hello %s, my name is %s", [null, "Bob"])).toBe(
      "Hello null, my name is Bob",
    );
    expect(formatStringValue("Hello %s, my name is %s", ["Alice", undefined])).toBe(
      "Hello Alice, my name is null",
    );
  });

  it("empty argument list returns the template verbatim (constant column)", () => {
    expect(formatStringValue("INACTIVE_COVERAGE", [])).toBe("INACTIVE_COVERAGE");
  });

  it("is lenient: more conversions than arguments format as null; extras ignored", () => {
    expect(formatStringValue("%s-%s", ["A"])).toBe("A-null");
    expect(formatStringValue("%s", ["A", "B"])).toBe("A");
  });

  it("supports width/zero-pad and %%/%n escapes like printf", () => {
    expect(formatStringValue("%05.1f", [3.14159])).toBe("003.1");
    expect(formatStringValue("%-6s|", ["ab"])).toBe("ab    |");
    expect(formatStringValue("100%% done", [])).toBe("100% done");
    expect(formatStringValue("a%nb", [])).toBe("a\nb");
  });

  it("renders the fraud-signal tutorial composition correctly", () => {
    // claim_id + "-" + signal_type via ConcatenateStrings — the Format string
    // panel produces the constant part.
    expect(formatStringValue("INACTIVE_COVERAGE", [])).toBe("INACTIVE_COVERAGE");
  });
});
