import { z } from "zod";
import { SearchJsonQueryV2 } from "../oss/objectSetDefinition";

export const AUTOMATION_SCHEMA_VERSION = 1 as const;
export const DatabaseUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export const PrincipalReferenceSchema = z.object({
  kind: z.enum(["user", "group", "service"]),
  id: z.string().min(1).max(512),
  displayName: z.string().min(1).max(500).optional(),
});

export const ValueBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("constant"),
    value: z.unknown(),
  }),
  z.object({
    kind: z.literal("condition-output"),
    path: z.string().min(1).max(500),
  }),
  z.object({
    kind: z.literal("object-property"),
    objectPath: z.string().min(1).max(500),
    propertyId: z.string().min(1).max(500),
  }),
  z.object({
    kind: z.literal("effect-output"),
    effectId: z.string().uuid(),
    path: z.string().min(1).max(500),
  }),
  z.object({
    kind: z.literal("system-value"),
    value: z.enum([
      "triggeredAt",
      "automationId",
      "automationVersion",
      "triggerEventId",
      "ownerId",
    ]),
  }),
]);

const MissedRunPolicySchema = z.enum(["skip", "fire-once"]);

export const IntervalScheduleSchema = z.object({
  kind: z.literal("interval"),
  frequency: z.enum(["hourly", "daily"]),
  every: z.number().int().min(1).max(365),
  timezone: z.string().min(1).max(100),
  timeOfDay: z
    .object({
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .optional(),
  anchorAt: z.string().datetime({ offset: true }),
  missedRunPolicy: MissedRunPolicySchema.default("fire-once"),
});

export const CronScheduleSchema = z.object({
  kind: z.literal("cron"),
  expression: z.string().min(1).max(500),
  timezone: z.string().min(1).max(100),
  missedRunPolicy: MissedRunPolicySchema.default("fire-once"),
});

export const ScheduleSchema = z.discriminatedUnion("kind", [
  IntervalScheduleSchema,
  CronScheduleSchema,
]);

const EvaluationModeSchema = z.enum([
  "live",
  "scheduled",
  "automation-dependent",
]);

const ObjectSetSchema = z.record(z.string(), z.unknown());

export const TimeConditionSchema = z.object({
  type: z.literal("time"),
  evaluationMode: z.literal("scheduled"),
  schedule: ScheduleSchema,
});

export const ObjectSetConditionSchema = z.object({
  type: z.enum([
    "objects-added",
    "objects-removed",
    "objects-modified",
    "run-on-all",
  ]),
  evaluationMode: EvaluationModeSchema,
  objectTypeApiName: z.string().max(500),
  objectSet: ObjectSetSchema,
  /**
   * Optional canonical property filter (SearchJsonQueryV2) that narrows the
   * monitored set. The effective query is `objectSet AND objectCondition`
   * (see `src/services/automate/objectCondition.ts` `effectiveObjectSet`).
   * Preview, validation, scheduled/live evaluation, run-on-all, and the
   * membership initialization/diff all compile this same effective set.
   */
  objectCondition: SearchJsonQueryV2.optional(),
  schedule: ScheduleSchema.optional(),
  monitoredProperties: z.array(z.string().min(1).max(500)).max(500).default([]),
  alsoTriggerWhenAdded: z.boolean().default(false),
  alsoTriggerWhenRemoved: z.boolean().default(false),
  batchSize: z.number().int().min(1).max(10_000).default(100),
});

const ThresholdMetricRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("metric"),
  objectSet: ObjectSetSchema,
  objectTypeApiName: z.string().min(1).max(500),
  aggregation: z.enum(["count", "sum", "avg", "min", "max"]),
  propertyApiName: z.string().min(1).max(500).optional(),
  operator: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]),
  comparisonValue: z.union([z.number(), z.string(), z.boolean()]),
});

const ThresholdFunctionRowSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("function"),
  functionRid: z.string().min(1).max(500).nullable().default(null),
  repositoryRid: z.string().min(1).max(500).nullable().default(null),
  apiName: z.string().min(1).max(500).nullable().default(null),
  branch: z.string().min(1).max(255).nullable().default(null),
  version: z.string().min(1).max(100).nullable().default(null),
  artifactSha256: z.string().min(1).max(128).nullable().default(null),
  parameters: z.record(z.string(), ValueBindingSchema),
});

export type ThresholdExpression =
  | z.infer<typeof ThresholdMetricRowSchema>
  | z.infer<typeof ThresholdFunctionRowSchema>
  | {
      id: string;
      kind: "group";
      operator: "and" | "or";
      children: ThresholdExpression[];
    };

export const ThresholdExpressionSchema: z.ZodType<ThresholdExpression> = z.lazy(
  () =>
    z.discriminatedUnion("kind", [
      ThresholdMetricRowSchema,
      ThresholdFunctionRowSchema,
      z.object({
        id: z.string().uuid(),
        kind: z.literal("group"),
        operator: z.enum(["and", "or"]),
        children: z.array(ThresholdExpressionSchema).max(100),
      }),
    ]),
);

export const ThresholdConditionSchema = z.object({
  type: z.literal("threshold-crossed"),
  evaluationMode: z.literal("scheduled"),
  expression: ThresholdExpressionSchema,
  direction: z.enum(["rising", "falling", "both"]).default("both"),
  schedule: ScheduleSchema,
});

export const DependencyConditionSchema = z.object({
  type: z.literal("automation-dependency"),
  evaluationMode: z.literal("automation-dependent"),
  parentAutomationId: z.string().uuid().nullable().default(null),
  delaySeconds: z.number().int().min(0).max(86_400).default(0),
  completionStatuses: z
    .array(z.enum(["succeeded", "partially-failed", "failed", "cancelled"]))
    .min(1)
    .default(["succeeded", "partially-failed", "failed"]),
  objectCondition: ObjectSetConditionSchema.optional(),
});

export const UnavailableConditionSchema = z.object({
  type: z.enum(["time-series", "stream", "metric-changed"]),
  unavailableReason: z.string().min(1).max(2_000),
});

export const ConditionDraftSchema = z.discriminatedUnion("type", [
  TimeConditionSchema,
  ObjectSetConditionSchema,
  ThresholdConditionSchema,
  DependencyConditionSchema,
  UnavailableConditionSchema,
]);

export const RetryPolicySchema = z.object({
  enabled: z.boolean().default(true),
  strategy: z.enum(["constant", "exponential"]).default("constant"),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  delaySeconds: z.number().min(1).max(86_400).default(10),
  multiplier: z.number().min(1).max(10).default(2),
  maxDelaySeconds: z.number().min(1).max(604_800).default(3_600),
  jitter: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("none"),
    }),
    z.object({
      kind: z.literal("factor"),
      factor: z.number().min(0).max(1),
    }),
    z.object({
      kind: z.literal("duration"),
      durationSeconds: z.number().min(0).max(86_400),
    }),
  ]),
  retryAllFailures: z.boolean().default(false),
});

const EffectBaseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(500),
  order: z.number().int().min(0).max(1_000),
  retry: RetryPolicySchema,
});

const ActionEffectCoreSchema = EffectBaseSchema.extend({
  type: z.literal("action"),
  actionTypeId: z.string().uuid().nullable().default(null),
  actionApiName: z.string().max(500).nullable().default(null),
  definitionVersion: z.number().int().min(1).nullable().default(null),
  definitionHash: z.string().min(1).max(256).nullable().default(null),
  parameters: z.record(z.string(), ValueBindingSchema),
});

const FunctionEffectCoreSchema = EffectBaseSchema.extend({
  type: z.literal("function"),
  functionRid: z.string().min(1).max(500).nullable().default(null),
  repositoryRid: z.string().min(1).max(500).nullable().default(null),
  apiName: z.string().min(1).max(500).nullable().default(null),
  branch: z.string().min(1).max(255).nullable().default(null),
  version: z.string().min(1).max(100).nullable().default(null),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable().default(null),
  autoUpgrade: z.boolean().default(false),
  parameters: z.record(z.string(), ValueBindingSchema),
  // The canonical Tellus Function sandbox currently enforces a five-second
  // hard budget. Automate cannot truthfully promise a longer invocation.
  timeoutSeconds: z.literal(5).default(5),
});

const LogicEffectCoreSchema = EffectBaseSchema.extend({
  type: z.literal("logic"),
  logicRid: z.string().min(1).max(500).nullable().default(null),
  version: z.string().min(1).max(100).nullable().default(null),
  parameters: z.record(z.string(), ValueBindingSchema),
  applyGeneratedActions: z.boolean().default(false),
});

const NotificationEffectCoreSchema = EffectBaseSchema.extend({
  type: z.literal("notification"),
  recipients: z.object({
    static: z.array(PrincipalReferenceSchema).max(1_000).default([]),
    dynamic: z.array(ValueBindingSchema).max(100).default([]),
  }),
  channels: z.array(z.enum(["in_app", "email"])).max(2),
  content: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("plain"),
      heading: z.string().max(500),
      message: z.string().max(20_000),
      url: z
        .string()
        .url()
        .max(2_000)
        .refine(
          (value) => ["http:", "https:"].includes(new URL(value).protocol),
          "Notification URLs must use HTTP or HTTPS.",
        )
        .optional(),
      useSystemFallback: z.boolean().default(false),
    }),
    z.object({
      kind: z.literal("function"),
      functionRid: z.string().min(1).max(500).nullable().default(null),
      repositoryRid: z.string().min(1).max(500).nullable().default(null),
      apiName: z.string().min(1).max(500).nullable().default(null),
      branch: z.string().min(1).max(255).nullable().default(null),
      version: z.string().min(1).max(100).nullable().default(null),
      artifactSha256: z.string().min(1).max(128).nullable().default(null),
      autoUpgrade: z.boolean().default(false),
      parameters: z.record(z.string(), ValueBindingSchema),
    }),
  ]),
  grouping: z.object({
    mode: z.enum(["all", "per-object", "properties"]),
    propertyApiNames: z.array(z.string().min(1).max(500)).max(20).default([]),
  }),
  locale: z.string().min(2).max(100).default("en-US"),
});

export const FallbackEffectSchema = z.discriminatedUnion("type", [
  ActionEffectCoreSchema,
  FunctionEffectCoreSchema,
  LogicEffectCoreSchema,
  NotificationEffectCoreSchema,
]);

export const EffectDraftSchema = z.discriminatedUnion("type", [
  ActionEffectCoreSchema.extend({
    fallbackEffect: FallbackEffectSchema.optional(),
  }),
  FunctionEffectCoreSchema.extend({
    fallbackEffect: FallbackEffectSchema.optional(),
  }),
  LogicEffectCoreSchema.extend({
    fallbackEffect: FallbackEffectSchema.optional(),
  }),
  NotificationEffectCoreSchema.extend({
    fallbackEffect: FallbackEffectSchema.optional(),
  }),
]);

export const AutoMutePolicySchema = z.object({
  enabled: z.boolean().default(true),
  minimumExecutions: z.number().int().min(1).max(10_000).default(30),
  failureRateThreshold: z.number().min(0).max(1).default(0.8),
  evaluationWindowSeconds: z
    .number()
    .int()
    .min(60)
    .max(31_536_000)
    .default(15_552_000),
});

export const AutomationSettingsDraftSchema = z.object({
  eventRetries: z.object({
    enabled: z.boolean().default(false),
    maxRetries: z.number().int().min(1).max(5).default(3),
    intervalSeconds: z.number().int().min(60).max(86_400).default(3_600),
  }),
  administrators: z.array(PrincipalReferenceSchema).max(100).default([]),
  informationNotificationAudience: z
    .enum(["owner-and-recipients", "administrators"])
    .default("owner-and-recipients"),
  effectFailureNotificationAudience: z
    .enum(["owner-and-recipients", "administrators"])
    .default("owner-and-recipients"),
  autoMute: AutoMutePolicySchema,
  historyScope: z.enum(["owner", "project"]).default("owner"),
  retainHistoryDays: z.number().int().min(1).max(365).default(180),
});

export const AutomationDraftSchema = z.object({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  ontologyId: DatabaseUuidSchema,
  name: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  condition: ConditionDraftSchema,
  effects: z.array(EffectDraftSchema).max(100),
  settings: AutomationSettingsDraftSchema,
  executionStrategy: z.object({
    mode: z.enum(["parallel", "sequential"]),
    queueTriggerEvents: z.boolean(),
  }),
  owner: PrincipalReferenceSchema.optional(),
});

export type PrincipalReference = z.infer<typeof PrincipalReferenceSchema>;
export type ValueBinding = z.infer<typeof ValueBindingSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type ConditionDraft = z.infer<typeof ConditionDraftSchema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type EffectDraft = z.infer<typeof EffectDraftSchema>;
export type AutomationSettingsDraft = z.infer<
  typeof AutomationSettingsDraftSchema
>;
export type AutomationDraft = z.infer<typeof AutomationDraftSchema>;

export type AutomationStatus =
  | "draft"
  | "active"
  | "paused"
  | "muted"
  | "disabled"
  | "archived";

export type WizardValidationStep =
  | "condition"
  | "time"
  | "effects"
  | "settings"
  | "summary";

export interface ValidationIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
  step: WizardValidationStep;
  effectId?: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  normalizedDraft?: AutomationDraft;
}
