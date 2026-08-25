import type { ConditionDraft } from "./contracts";

export type EvaluationMode = "live" | "scheduled" | "automation-dependent";

export interface ConditionCompatibility {
  live: boolean;
  scheduled: boolean;
  automationDependent: boolean;
  available: boolean;
  unavailableReason?: string;
}

export const CONDITION_COMPATIBILITY = {
  time: {
    live: false,
    scheduled: true,
    automationDependent: false,
    available: true,
  },
  "objects-added": {
    live: true,
    scheduled: true,
    automationDependent: true,
    available: true,
  },
  "objects-removed": {
    live: true,
    scheduled: true,
    automationDependent: true,
    available: true,
  },
  "objects-modified": {
    live: true,
    scheduled: false,
    automationDependent: false,
    available: true,
  },
  "run-on-all": {
    live: false,
    scheduled: true,
    automationDependent: true,
    available: true,
  },
  "threshold-crossed": {
    live: false,
    scheduled: true,
    automationDependent: false,
    available: true,
  },
  "automation-dependency": {
    live: false,
    scheduled: false,
    automationDependent: true,
    available: true,
  },
  "time-series": {
    live: false,
    scheduled: false,
    automationDependent: false,
    available: false,
    unavailableReason:
      "Tellus does not expose a permission-aware time-series alert source.",
  },
  stream: {
    live: false,
    scheduled: false,
    automationDependent: false,
    available: false,
    unavailableReason:
      "Tellus does not expose a user-facing stream registry for Automate.",
  },
  "metric-changed": {
    live: false,
    scheduled: false,
    automationDependent: false,
    available: false,
    unavailableReason: "Metric changed is sunset and cannot be activated.",
  },
} as const satisfies Record<ConditionDraft["type"], ConditionCompatibility>;

export function supportsEvaluationMode(
  conditionType: ConditionDraft["type"],
  mode: EvaluationMode,
): boolean {
  const entry = CONDITION_COMPATIBILITY[conditionType];
  if (!entry.available) return false;
  if (mode === "live") return entry.live;
  if (mode === "scheduled") return entry.scheduled;
  return entry.automationDependent;
}
