import { describe, expect, it } from "vitest";
import {
  AutomationDraftSchema,
  RetryPolicySchema,
} from "../../../src/services/automate/contracts";
import {
  describeSchedule,
  nextScheduleOccurrence,
  validateSchedule,
} from "../../../src/services/automate/schedule";
import {
  isNotificationFunctionOutputContract,
  validateAutomationDraft,
} from "../../../src/services/automate/validation";
import {
  retryDelaySeconds,
  shouldAutoMute,
} from "../../../src/services/automate/retry";
import {
  supportsEvaluationMode,
} from "../../../src/services/automate/compatibility";
import {
  compareMetric,
  thresholdTransitionCrossed,
} from "../../../src/services/automate/conditionRuntime";
import {
  canManageAutomation,
  canTransitionAutomation,
} from "../../../src/services/automate/repository";
import {
  expandNotificationRecipients,
  renderFunctionNotificationResult,
  renderNotificationContent,
} from "../../../src/services/automate/effectExecutors";
import {
  hasRuntimeMarkingBypass,
  isExecutableOwner,
} from "../../../src/services/automate/permissions";

const ontologyId = "11111111-1111-4111-8111-111111111111";
const actionTypeId = "22222222-2222-4222-8222-222222222222";
const effectId = "33333333-3333-4333-8333-333333333333";

function draft() {
  return {
    schemaVersion: 1,
    ontologyId,
    name: "Daily action",
    condition: {
      type: "time",
      evaluationMode: "scheduled",
      schedule: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "Africa/Kigali",
        missedRunPolicy: "fire-once",
      },
    },
    effects: [
      {
        id: effectId,
        name: "Update records",
        order: 0,
        type: "action",
        actionTypeId,
        actionApiName: "UpdateRecords",
        definitionVersion: 1,
        definitionHash: null,
        parameters: { message: { kind: "constant", value: "hello" } },
        retry: {
          enabled: true,
          strategy: "exponential",
          maxAttempts: 3,
          delaySeconds: 10,
          multiplier: 2,
          maxDelaySeconds: 60,
          jitter: { kind: "none" },
          retryAllFailures: false,
        },
      },
    ],
    settings: {
      eventRetries: { enabled: false, maxRetries: 3, intervalSeconds: 3600 },
      administrators: [],
      informationNotificationAudience: "owner-and-recipients",
      effectFailureNotificationAudience: "owner-and-recipients",
      autoMute: {
        enabled: true,
        minimumExecutions: 30,
        failureRateThreshold: 0.8,
        evaluationWindowSeconds: 15_552_000,
      },
      historyScope: "owner",
      retainHistoryDays: 180,
    },
    executionStrategy: { mode: "parallel", queueTriggerEvents: true },
  };
}

describe("Automate domain", () => {
  it("normalizes a complete typed draft and validates it", () => {
    const parsed = AutomationDraftSchema.parse(draft());
    expect(validateAutomationDraft(parsed)).toEqual({
      valid: true,
      issues: [],
      normalizedDraft: parsed,
    });
  });

  it("rejects effect-output bindings in parallel mode", () => {
    const value = draft();
    value.effects.push({
      ...value.effects[0],
      id: "44444444-4444-4444-8444-444444444444",
      name: "Second",
      order: 1,
      parameters: {
        message: {
          kind: "effect-output",
          effectId,
          path: "result",
        },
      },
    } as typeof value.effects[number]);
    const result = validateAutomationDraft(value);
    expect(result.valid).toBe(false);
    expect(result.issues.map((entry) => entry.code)).toContain(
      "BINDING_PARALLEL_EFFECT_FORBIDDEN",
    );
  });

  it("rejects later-effect references and accepts earlier sequential outputs", () => {
    const value = draft();
    value.executionStrategy.mode = "sequential";
    value.effects.push({
      ...value.effects[0],
      id: "44444444-4444-4444-8444-444444444444",
      name: "Second",
      order: 1,
      parameters: {
        message: {
          kind: "effect-output",
          effectId,
          path: "result",
        },
      },
    } as typeof value.effects[number]);
    expect(validateAutomationDraft(value).valid).toBe(true);
    value.effects[0].parameters = {
      message: {
        kind: "effect-output",
        effectId: value.effects[1].id,
        path: "result",
      },
    };
    expect(validateAutomationDraft(value).issues.map((entry) => entry.code))
      .toContain("BINDING_EFFECT_ORDER_INVALID");
  });

  it("limits fallback nesting to one typed level", () => {
    const value = draft();
    value.effects[0] = {
      ...value.effects[0],
      fallbackEffect: {
        ...value.effects[0],
        id: "55555555-5555-4555-8555-555555555555",
      },
    } as typeof value.effects[number];
    expect(AutomationDraftSchema.parse(value).effects[0].fallbackEffect?.type)
      .toBe("action");
  });
});

describe("Automate schedules", () => {
  it("calculates the next cron occurrence in the configured timezone", () => {
    const schedule = {
      kind: "cron" as const,
      expression: "0 9 * * *",
      timezone: "Africa/Kigali",
      missedRunPolicy: "fire-once" as const,
    };
    expect(
      nextScheduleOccurrence(schedule, new Date("2026-07-29T06:30:00.000Z"))
        .toISOString(),
    ).toBe("2026-07-29T07:00:00.000Z");
    expect(describeSchedule(schedule)).toContain("Africa/Kigali");
  });

  it("handles a daylight-saving spring transition deterministically", () => {
    const schedule = {
      kind: "cron" as const,
      expression: "30 2 * * *",
      timezone: "America/New_York",
      missedRunPolicy: "fire-once" as const,
    };
    const next = nextScheduleOccurrence(
      schedule,
      new Date("2026-03-08T06:00:00.000Z"),
    );
    // The nonexistent 02:30 local time is advanced to 03:30 on the DST day.
    expect(next.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("rejects invalid cron and timezone values", () => {
    expect(() =>
      validateSchedule({
        kind: "cron",
        expression: "not cron",
        timezone: "Not/AZone",
        missedRunPolicy: "skip",
      }),
    ).toThrow(/timezone/i);
  });

  it("handles month and leap-year boundaries", () => {
    const schedule = {
      kind: "cron" as const,
      expression: "0 0 29 2 *",
      timezone: "UTC",
      missedRunPolicy: "skip" as const,
    };
    expect(
      nextScheduleOccurrence(schedule, new Date("2027-03-01T00:00:00.000Z"))
        .toISOString(),
    ).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("Automate retry and mute policies", () => {
  const retry = RetryPolicySchema.parse({
    enabled: true,
    strategy: "exponential",
    maxAttempts: 4,
    delaySeconds: 10,
    multiplier: 2,
    maxDelaySeconds: 25,
    jitter: { kind: "factor", factor: 0.2 },
    retryAllFailures: false,
  });

  it("bounds exponential delay and factor jitter", () => {
    expect(retryDelaySeconds(retry, 1, () => 0)).toBe(8);
    expect(retryDelaySeconds(retry, 2, () => 1)).toBe(24);
    expect(retryDelaySeconds(retry, 3, () => 0.5)).toBe(25);
    expect(retryDelaySeconds(retry, 4, () => 0.5)).toBe(0);
  });

  it("mutes only after the configured sample and failure threshold", () => {
    expect(
      shouldAutoMute({
        enabled: true,
        minimumExecutions: 5,
        failureRateThreshold: 0.8,
        outcomes: ["failed", "failed", "failed", "failed"],
      }),
    ).toBe(false);
    expect(
      shouldAutoMute({
        enabled: true,
        minimumExecutions: 5,
        failureRateThreshold: 0.8,
        outcomes: ["failed", "failed", "failed", "failed", "succeeded"],
      }),
    ).toBe(true);
  });

  it("bounds duration jitter and never returns a negative delay", () => {
    const durationRetry = RetryPolicySchema.parse({
      ...retry,
      strategy: "constant",
      delaySeconds: 3,
      jitter: { kind: "duration", durationSeconds: 10 },
    });
    expect(retryDelaySeconds(durationRetry, 1, () => 0)).toBe(0);
    expect(retryDelaySeconds(durationRetry, 1, () => 1)).toBe(13);
  });
});

describe("Automate compatibility, thresholds, and lifecycle", () => {
  it("uses the backend-owned evaluation compatibility matrix", () => {
    expect(supportsEvaluationMode("objects-added", "live")).toBe(true);
    expect(supportsEvaluationMode("objects-modified", "scheduled")).toBe(false);
    expect(supportsEvaluationMode("stream", "live")).toBe(false);
    expect(supportsEvaluationMode("automation-dependency", "automation-dependent"))
      .toBe(true);
  });

  it("renders notification preview through the delivery sanitizer", () => {
    const effect = {
      ...draft().effects[0],
      type: "notification" as const,
      recipients: { static: [], dynamic: [] },
      channels: ["in_app" as const],
      content: {
        kind: "plain" as const,
        heading: "<script>alert(1)</script>",
        message: "A & B",
        url: "https://example.com/event",
        useSystemFallback: false,
      },
      grouping: { mode: "all" as const, propertyApiNames: [] },
      locale: "en-US",
    };
    expect(renderNotificationContent(effect)).toEqual({
      heading: "&lt;script&gt;alert(1)&lt;/script&gt;",
      message: "A &amp; B",
      url: "https://example.com/event",
      locale: "en-US",
    });
    expect(() =>
      AutomationDraftSchema.parse({
        ...draft(),
        effects: [
          {
            ...effect,
            content: { ...effect.content, url: "javascript:alert(1)" },
          },
        ],
      }),
    ).toThrow(/HTTP or HTTPS/);
  });

  it("validates and sanitizes Function-generated notification output", () => {
    expect(
      isNotificationFunctionOutputContract(
        "{ heading: string; message: string; url?: string; locale?: string }",
      ),
    ).toBe(true);
    expect(
      isNotificationFunctionOutputContract(
        "{ heading: string; body: string }",
      ),
    ).toBe(false);
    expect(
      renderFunctionNotificationResult(
        {
          heading: "<b>Generated</b>",
          message: "Object <script>alert(1)</script> changed",
          url: "https://example.com/object/1",
          locale: "en-GB",
        },
        "en-US",
      ),
    ).toEqual({
      heading: "&lt;b&gt;Generated&lt;/b&gt;",
      message:
        "Object &lt;script&gt;alert(1)&lt;/script&gt; changed",
      url: "https://example.com/object/1",
      locale: "en-GB",
    });
    expect(() =>
      renderFunctionNotificationResult(
        {
          heading: "Unsafe",
          message: "Unsafe URL",
          url: "javascript:alert(1)",
        },
        "en-US",
      ),
    ).toThrow(/HTTP or HTTPS/);
    expect(() =>
      renderFunctionNotificationResult("not an object", "en-US"),
    ).toThrow(/must return an object/);
  });

  it("expands notification groups, removes disabled users, and deduplicates", async () => {
    const recipients = await expandNotificationRecipients(
      [
        { kind: "user", id: "user-a" },
        { kind: "group", id: "group-one" },
      ],
      async () => [
        { id: "user-a", enabled: true },
        { id: "user-b", enabled: true },
        { id: "user-disabled", enabled: false },
      ],
    );
    expect(recipients).toEqual([
      { kind: "user", id: "user-a" },
      { kind: "user", id: "user-b" },
    ]);
  });

  it("distinguishes a threshold transition from remaining above", () => {
    expect(compareMetric(11, "gt", 10)).toBe(true);
    expect(thresholdTransitionCrossed(false, true, "rising")).toBe(true);
    expect(thresholdTransitionCrossed(true, true, "rising")).toBe(false);
    expect(thresholdTransitionCrossed(null, true, "both")).toBe(false);
    expect(thresholdTransitionCrossed(true, false, "falling")).toBe(true);
  });

  it("accepts pinned Boolean threshold Functions with constant inputs", () => {
    const value = AutomationDraftSchema.parse(draft());
    value.condition = {
      type: "threshold-crossed",
      evaluationMode: "scheduled",
      expression: {
        id: "44444444-4444-4444-8444-444444444444",
        kind: "group",
        operator: "and",
        children: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            kind: "function",
            functionRid: "ri.function.main.function.boolean-check",
            repositoryRid: "ri.stemma.main.repository.boolean-check",
            apiName: "isThresholdMet",
            branch: "main",
            version: "1.0.0",
            artifactSha256: "a".repeat(64),
            parameters: {
              minimum: { kind: "constant", value: 10 },
            },
          },
        ],
      },
      direction: "rising",
      schedule: {
        kind: "interval",
        frequency: "hourly",
        every: 1,
        timezone: "UTC",
        anchorAt: "2026-07-29T00:00:00.000Z",
        missedRunPolicy: "fire-once",
      },
    };
    expect(validateAutomationDraft(value).valid).toBe(true);

    if (
      value.condition.type !== "threshold-crossed" ||
      value.condition.expression.kind !== "group" ||
      value.condition.expression.children[0]?.kind !== "function"
    ) {
      throw new Error("Expected the threshold Function fixture.");
    }
    value.condition.expression.children[0].parameters.minimum = {
      kind: "condition-output",
      path: "currentValue",
    };
    expect(
      validateAutomationDraft(value).issues.map((entry) => entry.code),
    ).toContain("THRESHOLD_FUNCTION_BINDING_UNSUPPORTED");
  });

  it("enforces terminal archive and resumable pause/mute states", () => {
    expect(canTransitionAutomation("draft", "active")).toBe(true);
    expect(canTransitionAutomation("active", "paused")).toBe(true);
    expect(canTransitionAutomation("muted", "active")).toBe(true);
    expect(canTransitionAutomation("archived", "active")).toBe(false);
    expect(canTransitionAutomation("draft", "muted")).toBe(false);
  });

  it("authorizes owners, user administrators, and current group members", () => {
    const administrators = [
      { kind: "user" as const, id: "administrator-user" },
      { kind: "group" as const, id: "operations-group" },
    ];
    expect(
      canManageAutomation({
        ownerUserId: "owner",
        administrators,
        actorUserId: "owner",
      }),
    ).toBe(true);
    expect(
      canManageAutomation({
        ownerUserId: "owner",
        administrators,
        actorUserId: "administrator-user",
      }),
    ).toBe(true);
    expect(
      canManageAutomation({
        ownerUserId: "owner",
        administrators,
        actorUserId: "group-user",
        actorGroupIds: ["operations-group"],
      }),
    ).toBe(true);
    expect(
      canManageAutomation({
        ownerUserId: "owner",
        administrators,
        actorUserId: "former-group-user",
        actorGroupIds: [],
      }),
    ).toBe(false);
  });

  it("fails closed for deleted or disabled owners", () => {
    expect(isExecutableOwner(null)).toBe(false);
    expect(isExecutableOwner({ enabled: false })).toBe(false);
    expect(isExecutableOwner({ enabled: true })).toBe(true);
  });

  it("derives marking bypass only from current superadmin roles", () => {
    expect(hasRuntimeMarkingBypass(["ontology-editor"])).toBe(false);
    expect(hasRuntimeMarkingBypass(["TELLUS-SUPERADMIN"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Supported-subset capability scope (Outcome B). Capabilities with no
// canonical Tellus platform dependency (time-series, stream, metric-changed
// conditions; Logic effect) are kept in the UI as visibly disabled cards but
// must be REJECTED at the backend boundary so a forged activation payload
// cannot route a specialized capability through the system. These tests pin
// the backend rejection: the named missing dependency is surfaced as a
// stable error code and the compatibility matrix is the single source of
// truth for what is unavailable.
// ---------------------------------------------------------------------------
import {
  CONDITION_COMPATIBILITY,
} from "../../../src/services/automate/compatibility";
// supportsEvaluationMode is already imported at the top of this file.

describe("Supported-subset capability scope (Outcome B)", () => {
  const unavailable: Array<{
    type: "time-series" | "stream" | "metric-changed";
    needle: string;
  }> = [
    { type: "time-series", needle: "time-series alert source" },
    { type: "stream", needle: "stream registry" },
    { type: "metric-changed", needle: "sunset" },
  ];

  it("marks time-series/stream/metric-changed unavailable with a named missing dependency", () => {
    for (const { type, needle } of unavailable) {
      const entry = CONDITION_COMPATIBILITY[type];
      expect(entry.available).toBe(false);
      expect(entry.unavailableReason ?? "").toContain(needle);
    }
  });

  it("rejects forged time-series / stream / metric-changed condition payloads with CONDITION_UNAVAILABLE", () => {
    for (const { type } of unavailable) {
      const value = draft();
      value.condition = {
        type,
        unavailableReason:
          CONDITION_COMPATIBILITY[type].unavailableReason ?? "unavailable",
      } as never;
      const parsed = AutomationDraftSchema.parse(value);
      const result = validateAutomationDraft(parsed);
      expect(result.issues.some((i) => i.code === "CONDITION_UNAVAILABLE")).toBe(true);
      expect(
        result.issues.some((i) =>
          (i.message ?? "").includes(
            CONDITION_COMPATIBILITY[type].unavailableReason ?? "",
          ),
        ),
      ).toBe(true);
    }
  });

  it("does not expose any evaluation mode for unavailable conditions", () => {
    for (const { type } of unavailable) {
      expect(supportsEvaluationMode(type, "live")).toBe(false);
      expect(supportsEvaluationMode(type, "scheduled")).toBe(false);
    }
  });

  it("rejects a forged Logic effect at activation with LOGIC_RUNTIME_UNAVAILABLE naming the missing registry", () => {
    const value = draft();
    value.effects = [
      {
        id: effectId,
        name: "Forged logic",
        order: 0,
        type: "logic",
        logicRid: "ri.logic.main.forged",
        parameters: {},
        retry: {
          enabled: false,
          strategy: "constant",
          maxAttempts: 1,
          delaySeconds: 10,
          multiplier: 2,
          maxDelaySeconds: 60,
          jitter: { kind: "none" },
          retryAllFailures: false,
        },
      } as never,
    ];
    const parsed = AutomationDraftSchema.parse(value);
    const result = validateAutomationDraft(parsed);
    expect(
      result.issues.some((i) => i.code === "LOGIC_RUNTIME_UNAVAILABLE"),
    ).toBe(true);
    expect(
      result.issues.some((i) =>
        (i.message ?? "").toLowerCase().includes("logic registry"),
      ),
    ).toBe(true);
  });

  it("does not disguise Logic throughput: the effect type is distinct from action/function/notification", () => {
    const value = draft();
    value.effects = [
      {
        id: effectId,
        name: "Forged logic",
        order: 0,
        type: "logic",
        logicRid: "ri.logic.main.forged",
        parameters: {},
        retry: {
          enabled: false,
          strategy: "constant",
          maxAttempts: 1,
          delaySeconds: 10,
          multiplier: 2,
          maxDelaySeconds: 60,
          jitter: { kind: "none" },
          retryAllFailures: false,
        },
      } as never,
    ];
    const parsed = AutomationDraftSchema.parse(value);
    expect(parsed.effects[0].type).toBe("logic");
    // A valid action/function/notification effect must NOT parse as logic.
    expect(parsed.effects[0].type).not.toBe("action");
    expect(parsed.effects[0].type).not.toBe("function");
  });
});
