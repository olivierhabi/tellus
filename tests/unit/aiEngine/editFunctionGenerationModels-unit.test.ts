// ---------------------------------------------------------------------------
// editFunctionGenerationModels — Phase 3 contract-matrix regression.
//
// The Phase 3 AI contract matrix must contain ONLY models explicitly
// enabled for edit-function generation in this deployment. A model
// present in the engine's general-purpose /api/models catalog but NOT
// allowlisted (e.g. glm-5.2 — no provider entitlement in this
// deployment) must be excluded from the contract matrix.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";

import {
  EDIT_FUNCTION_GENERATION_MODELS,
  selectEditContractModels,
  supportsEditFunctionGeneration,
} from "../../../src/services/aiEngine/editFunctionGenerationModels";

describe("edit-function generation model allowlist", () => {
  it("contains exactly the supported Gemini models", () => {
    expect(EDIT_FUNCTION_GENERATION_MODELS.map((m) => m.key)).toEqual([
      "gemini-2.5-flash",
      "gemini-3.1-flash-lite",
    ]);
    for (const m of EDIT_FUNCTION_GENERATION_MODELS) {
      expect(m.supportsEditFunctionGeneration).toBe(true);
    }
  });

  it("recognizes only allowlisted models as edit-generation capable", () => {
    expect(supportsEditFunctionGeneration("gemini-2.5-flash")).toBe(true);
    expect(supportsEditFunctionGeneration("gemini-3.1-flash-lite")).toBe(true);
    // NOT enabled for edit-function generation in this deployment:
    expect(supportsEditFunctionGeneration("glm-5.2")).toBe(false);
    expect(supportsEditFunctionGeneration("gpt-5")).toBe(false);
    expect(supportsEditFunctionGeneration("")).toBe(false);
  });

  it("excludes non-enabled catalog models from the contract matrix", () => {
    // Live catalog contains a model this deployment cannot serve.
    const liveCatalog = [
      "glm-5.2",
      "gemini-2.5-flash",
      "gemini-3.1-flash-lite",
    ];
    const matrix = selectEditContractModels(liveCatalog);
    expect(matrix).toEqual(["gemini-2.5-flash", "gemini-3.1-flash-lite"]);
    expect(matrix).not.toContain("glm-5.2");
  });

  it("drops allowlisted models absent from the live catalog", () => {
    const matrix = selectEditContractModels(["gemini-2.5-flash"]);
    expect(matrix).toEqual(["gemini-2.5-flash"]);
  });

  it("returns an empty matrix when the catalog has no allowlisted model", () => {
    expect(selectEditContractModels(["glm-5.2"])).toEqual([]);
    expect(selectEditContractModels([])).toEqual([]);
  });
});
