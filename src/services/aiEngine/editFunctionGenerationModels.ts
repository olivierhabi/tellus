// ---------------------------------------------------------------------------
// editFunctionGenerationModels.ts — authoritative allowlist of the models
// enabled for AI EDIT-FUNCTION generation (typescript-v2 generate mode) in
// this deployment.
//
// The AI engine's SUPPORTED_MODELS catalog (proxied at
// GET /v1/code-assistant/models) is a GENERAL-PURPOSE catalog: a model
// being listed there does NOT mean it is enabled, authorized, or intended
// for edit-function generation. The edit-generation feature owns this
// allowlist; the Phase 3 contract matrix is exactly this set (intersected
// with the live engine catalog).
//
// A model is allowlisted only when ALL of the following hold:
//   1. Explicitly enabled for edit-function generation in this deployment.
//   2. Authorized by the available provider account (generation succeeds
//      with the deployment's credentials).
//   3. Intended to be supported long-term in this deployment.
//
// `glm-5.2` is deliberately NOT allowlisted: the provider account backing
// this deployment has no entitlement for it (provider returns
// AccessDenied.Unpurchased). It remains in the engine's general catalog
// but must never be selected for, or block, edit-function generation.
// ---------------------------------------------------------------------------

export interface EditGenerationModelCapability {
  key: string;
  supportsEditFunctionGeneration: true;
}

/** The supported edit-function generation model set (ordered). */
export const EDIT_FUNCTION_GENERATION_MODELS: readonly EditGenerationModelCapability[] =
  [
    { key: "gemini-2.5-flash", supportsEditFunctionGeneration: true },
    { key: "gemini-3.1-flash-lite", supportsEditFunctionGeneration: true },
  ] as const;

/** True when `key` is enabled for edit-function generation. */
export function supportsEditFunctionGeneration(key: string): boolean {
  return EDIT_FUNCTION_GENERATION_MODELS.some((m) => m.key === key);
}

/**
 * The Phase 3 contract matrix: allowlisted models that are also present in
 * the live engine catalog. Models in the live catalog that are NOT
 * allowlisted are excluded — the contract never tests, requires, or blocks
 * on a general-catalog model that edit-generation has not enabled.
 */
export function selectEditContractModels(liveCatalogKeys: string[]): string[] {
  const live = new Set(liveCatalogKeys);
  return EDIT_FUNCTION_GENERATION_MODELS.map((m) => m.key).filter((key) =>
    live.has(key),
  );
}
