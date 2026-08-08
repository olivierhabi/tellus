import { describe, expect, it } from "vitest";

import {
  checkPinnedActionDefinition,
  type ActionTypeValidationRow,
} from "../../../src/services/automate/validation";
import type { EffectDraft } from "../../../src/services/automate/contracts";

// Tiering unit coverage for the pin check — no DB required: the row shape
// is a plain object, classification is fed by the caller (history lookup
// lives in validateActionReference).
const ROW_0CB6 =
  "0cb64a007ea6AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function actionEffect(
  over: Partial<Extract<EffectDraft, { type: "action" }>> = {},
): Extract<EffectDraft, { type: "action" }> {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    name: "Create thing",
    type: "action",
    order: 0,
    retry: {
      enabled: false,
      strategy: "constant",
      maxAttempts: 1,
      delaySeconds: 1,
      multiplier: 2,
      maxDelaySeconds: 1,
      jitter: { kind: "none" },
      retryAllFailures: false,
    },
    actionTypeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    actionApiName: "createAckmanualsrc",
    definitionVersion: 4,
    definitionHash: ROW_0CB6,
    parameters: {},
    ...over,
  };
}

function row(over: Partial<ActionTypeValidationRow> = {}): ActionTypeValidationRow {
  return {
    action_type_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    api_name: "createAckmanualsrc",
    is_enabled: true,
    definition_version: 4,
    definition_hash: ROW_0CB6,
    parameters: [],
    ...over,
  };
}

describe("checkPinnedActionDefinition — validation tiering", () => {
  it("same version + apiName → unchanged (never consults hashes)", () => {
    expect(checkPinnedActionDefinition(actionEffect(), row()).status).toBe("unchanged");
    expect(
      checkPinnedActionDefinition(actionEffect({ definitionHash: null }), row({ definition_hash: null })).status,
    ).toBe("unchanged");
  });

  it("renamed action type → breaking, actionable message", () => {
    const check = checkPinnedActionDefinition(actionEffect(), row({ api_name: "otherApi" }));
    if (check.status !== "rejected") throw new Error("expected rejection");
    expect(check.issue.code).toBe("ACTION_DEFINITION_CHANGED_BREAKING");
    expect(check.issue.message).toContain("re-select the Action Type");
  });

  it("version bump with identical content hash → refreshed repin (no issue)", () => {
    const check = checkPinnedActionDefinition(
      actionEffect({ definitionVersion: 3 }),
      row({ definition_version: 4 }),
    );
    if (check.status !== "repin") throw new Error(`expected repin, got ${check.status}`);
    expect(check.repin.kind).toBe("refreshed");
    expect(check.repin.definitionVersion).toBe(4);
    expect(check.repin.previousDefinitionVersion).toBe(3);
    expect(check.warning).toBeUndefined();
  });

  it("compatible evolution (classified) → upgraded repin + WARNING issue", () => {
    const pinnedCanonical = {
      parameters: [{ apiName: "x", type: "string", required: true }],
      rules: [],
    };
    const check = checkPinnedActionDefinition(
      actionEffect({ definitionVersion: 3, definitionHash: null }),
      row({ definition_version: 4, definition_hash: null, parameters: [
        { apiName: "x", type: "string", required: true },
        { apiName: "note", type: "string", required: false },
      ] }),
      pinnedCanonical,
    );
    if (check.status !== "repin") throw new Error("expected repin");
    expect(check.repin.kind).toBe("upgraded");
    if (!check.warning) throw new Error("expected warning");
    expect(check.warning.code).toBe("ACTION_DEFINITION_CHANGED_COMPATIBLE");
    expect(check.warning.severity).toBe("warning");
  });

  it("breaking evolution (classified) → hard error with summary + remediation", () => {
    const check = checkPinnedActionDefinition(
      actionEffect({ definitionVersion: 3, definitionHash: null }),
      row({ definition_version: 4, definition_hash: null, parameters: [] }),
      { parameters: [{ apiName: "x", type: "string", required: true }], rules: [] },
    );
    if (check.status !== "rejected") throw new Error("expected rejection");
    expect(check.issue.code).toBe("ACTION_DEFINITION_CHANGED_BREAKING");
    expect(check.issue.message).toContain("parameter `x` removed");
    expect(check.issue.message).toContain("re-select the Action Type");
    expect(Array.isArray(check.issue.details?.changes)).toBe(true);
  });

  it("unknown pinned definition (no history) → legacy deprecated-alias error", () => {
    const check = checkPinnedActionDefinition(
      actionEffect({ definitionVersion: 3, definitionHash: null }),
      row({ definition_version: 4, definition_hash: null }),
      null,
    );
    if (check.status !== "rejected") throw new Error("expected rejection");
    expect(check.issue.code).toBe("ACTION_DEFINITION_CHANGED");
  });
});
