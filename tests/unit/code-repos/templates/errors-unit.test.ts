// B3 — Templates error catalog unit tests.

import { describe, it, expect } from "vitest";
import {
  TEMPLATES_ERROR_NAMES,
  TEMPLATES_ERROR_STATUS,
  templatesError,
  isTemplatesErrorName,
} from "../../../../src/services/templates/errors.js";
import { ERROR_NAME_REGEX } from "../../../../src/services/codeRepos/contracts/regex.js";

describe("Templates error catalog", () => {
  it("enumerates exactly 7 error names (3 spec + 4 cross-cutting)", () => {
    expect(TEMPLATES_ERROR_NAMES.length).toBe(7);
    expect(new Set(TEMPLATES_ERROR_NAMES).size).toBe(7);
  });

  it("every name conforms to ERROR_NAME_REGEX (G-C-13)", () => {
    for (const n of TEMPLATES_ERROR_NAMES) expect(n).toMatch(ERROR_NAME_REGEX);
  });

  it("every spec-mandated name has the expected status", () => {
    expect(TEMPLATES_ERROR_STATUS["Templates:NotFound"].status).toBe(404);
    expect(TEMPLATES_ERROR_STATUS["Templates:VersionDeprecated"].status).toBe(410);
    expect(TEMPLATES_ERROR_STATUS["Templates:ParameterValidationFailed"].status).toBe(400);
  });

  it("templatesError returns 4-key envelope per G-C-12", () => {
    const e = templatesError("Templates:NotFound", { templateId: "x" });
    expect(e.status).toBe(404);
    const keys = Object.keys(e.envelope).sort();
    expect(keys).toEqual(["errorCode", "errorInstanceId", "errorName", "parameters"]);
    expect(e.envelope.errorName).toBe("Templates:NotFound");
    expect(e.envelope.parameters).toEqual({ templateId: "x" });
  });

  it("preserves caller-provided errorInstanceId", () => {
    const e = templatesError("Templates:Internal", {}, "00000000-0000-4000-8000-000000000001");
    expect(e.envelope.errorInstanceId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("isTemplatesErrorName positive + negative", () => {
    expect(isTemplatesErrorName("Templates:NotFound")).toBe(true);
    expect(isTemplatesErrorName("Templates:Bogus")).toBe(false);
    expect(isTemplatesErrorName("Stemma:Other")).toBe(false);
  });
});
