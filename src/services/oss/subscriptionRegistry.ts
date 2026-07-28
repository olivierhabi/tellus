// ---------------------------------------------------------------------------
// ObjectSet subscriptions (Phase 12)
//
// Reuses the existing eventBus (`object_set.changed` events from
// the action executor — already emitted post-commit) instead of
// a second event pipeline.
//
// Design:
//   * A subscription registers its COMPILED object set
//     (fingerprint-keyed) + a change callback.
//   * On `object_set.changed` we do NOT re-run the set against
//     the index: we short-circuit on (objectType ∈ plan types),
//     then re-evaluate only the changed objects through the
//     in-memory where-matcher.
//   * ADDED_OR_UPDATED / REMOVED states follow the verified
//     ObjectSetUpdate contract.
// ---------------------------------------------------------------------------

import { eventBus } from "../../websocket/eventBus";
import type { CompiledObjectSet } from "./objectSetCompiler";
import { objectSetFingerprint, type ObjectSet } from "./objectSetDefinition";

export const MAX_SUBSCRIPTIONS_PER_USER = Number(
  process.env.TELLUS_MAX_OBJECTSET_SUBSCRIPTIONS ?? 100,
);

export type ObjectSetUpdateState = "ADDED_OR_UPDATED" | "REMOVED";

export interface ObjectSetUpdateEvent {
  type: "objectSetChanged";
  subscriptionId: string;
  updates: Array<{
    objectType: string;
    primaryKey: string;
    state: ObjectSetUpdateState;
  }>;
}

export interface Subscription {
  id: string;
  userId: string;
  fingerprint: string;
  objectTypes: Set<string>;
  /** where-DSL per object type (null = match all). */
  wheres: Map<string, unknown>;
  onUpdate: (event: ObjectSetUpdateEvent) => void;
}

export class SubscriptionLimitError extends Error {
  constructor(public readonly errorName: string, message: string) {
    super(message);
    this.name = "SubscriptionLimitError";
  }
}

// ---------------------------------------------------------------------------
// In-memory where-DSL matcher — used to re-evaluate membership of
// CHANGED objects without an index round-trip. Covers the leaf
// operators the change stream can affect; geo/interval fall back
// to "unknown → emit ADDED_OR_UPDATED" (defensible: subscribers
// re-fetch on update).
// ---------------------------------------------------------------------------

export function matchesWhere(
  doc: Record<string, unknown>,
  where: unknown,
): boolean {
  if (!where || typeof where !== "object") return true;
  const w = where as Record<string, unknown>;
  const field = w.field as string | undefined;
  const value = field ? doc[field] : undefined;
  switch (w.type) {
    case "and":
      return (w.value as unknown[]).every((c) => matchesWhere(doc, c));
    case "or":
      return (w.value as unknown[]).some((c) => matchesWhere(doc, c));
    case "not":
      return !matchesWhere(doc, (w.value as unknown[])[0]);
    case "eq": return value === w.value || String(value) === String(w.value);
    case "gt": return typeof value === "number" && value > (w.value as number);
    case "gte": return typeof value === "number" && value >= (w.value as number);
    case "lt": return typeof value === "number" && value < (w.value as number);
    case "lte": return typeof value === "number" && value <= (w.value as number);
    case "in":
      return (w.value as unknown[]).some(
        (v) => value === v || String(value) === String(v),
      );
    case "isNull": return value === null || value === undefined;
    case "isNotNull": return value !== null && value !== undefined;
    case "startsWith":
      return typeof value === "string" && value.startsWith(String(w.value));
    // Text/geo/interval: membership unknown client-side → treat as
    // matching so subscribers get an update and re-fetch.
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

class SubscriptionRegistry {
  private byUser = new Map<string, Map<string, Subscription>>();
  private listenerAttached = false;

  register(sub: Subscription): void {
    const userSubs = this.byUser.get(sub.userId) ?? new Map();
    if (userSubs.size >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw new SubscriptionLimitError(
        "SubscriptionLimitExceeded",
        `User has reached the ${MAX_SUBSCRIPTIONS_PER_USER} subscription limit.`,
      );
    }
    userSubs.set(sub.id, sub);
    this.byUser.set(sub.userId, userSubs);
    this.attachListener();
  }

  unregister(userId: string, subscriptionId: string): boolean {
    const userSubs = this.byUser.get(userId);
    if (!userSubs) return false;
    const removed = userSubs.delete(subscriptionId);
    if (userSubs.size === 0) this.byUser.delete(userId);
    return removed;
  }

  /** Drop ALL of a user's subscriptions (disconnect cleanup). */
  unregisterAll(userId: string): void {
    this.byUser.delete(userId);
  }

  subscriptionCount(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  private attachListener(): void {
    if (this.listenerAttached) return;
    this.listenerAttached = true;
    eventBus.on("ws:event", (event: { event?: string; payload?: unknown }) => {
      if (event.event !== "object_set.changed") return;
      this.onChange(event.payload);
    });
  }

  private onChange(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const p = payload as {
      objectType?: string;
      primaryKeys?: Array<string | number>;
      objects?: Array<Record<string, unknown>>;
    };
    const objectType = p.objectType;
    if (!objectType) return;
    const pks = (p.primaryKeys ?? [])
      .map(String)
      .filter(Boolean);
    const docsByPk = new Map<string, Record<string, unknown>>();
    for (const o of p.objects ?? []) {
      const pk = String(o.__primaryKey ?? o.__pk ?? "");
      if (pk) docsByPk.set(pk, o);
    }
    for (const userSubs of this.byUser.values()) {
      for (const sub of userSubs.values()) {
        if (!sub.objectTypes.has(objectType)) continue;
        const where = sub.wheres.get(objectType);
        const updates: ObjectSetUpdateEvent["updates"] = [];
        for (const pk of pks) {
          const doc = docsByPk.get(pk);
          const matches = doc ? matchesWhere(doc, where) : true;
          updates.push({
            objectType,
            primaryKey: pk,
            state: matches ? "ADDED_OR_UPDATED" : "REMOVED",
          });
        }
        if (updates.length > 0) {
          try {
            sub.onUpdate({
              type: "objectSetChanged",
              subscriptionId: sub.id,
              updates,
            });
          } catch {
            // A broken consumer must never break the event bus.
          }
        }
      }
    }
  }
}

export const subscriptionRegistry = new SubscriptionRegistry();

/** Build a Subscription from a compiled object set. */
export function subscriptionFromCompiled(opts: {
  id: string;
  userId: string;
  objectSet: ObjectSet;
  compiled: CompiledObjectSet;
  onUpdate: (event: ObjectSetUpdateEvent) => void;
}): Subscription {
  const objectTypes = new Set<string>();
  const wheres = new Map<string, unknown>();
  for (const plan of opts.compiled.plans) {
    objectTypes.add(plan.objectType);
    wheres.set(plan.objectType, plan.where ?? null);
    if (plan.searchAround) {
      objectTypes.add(plan.searchAround.fromObjectType);
    }
  }
  return {
    id: opts.id,
    userId: opts.userId,
    fingerprint: objectSetFingerprint(opts.objectSet),
    objectTypes,
    wheres,
    onUpdate: opts.onUpdate,
  };
}
