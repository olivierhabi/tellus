// ---------------------------------------------------------------------------
// Migration 173 — action_type.security_settings resolver/normalizer tests.
//
// Every assertion here is really an assertion about a SAFETY DIRECTION, not
// just about a return value:
//
//   * A malformed or partial blob must resolve to the restrictive default,
//     because the executor reads these to decide whether a branch rehearsal
//     may call a real webhook or email real users.
//   * The one non-restrictive default (allowAutomateSubmission) must stay
//     non-restrictive, because flipping it would silently break every
//     automation that predates this column.
//   * The branch helper must fail toward "this is main" when the main branch
//     id is unresolvable, because failing the other way would suppress every
//     side effect on a transitional deployment with no diagnostic.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  DEFAULT_ACTION_SECURITY_SETTINGS,
  resolveActionSecuritySettings,
  normalizeActionSecuritySettings,
  isNonMainBranch,
  filterSideEffectsForBranch,
  type ActionSecuritySettings,
} from "../../../src/actions/actionSecuritySettings";

const DEFAULTS = DEFAULT_ACTION_SECURITY_SETTINGS;

describe("resolveActionSecuritySettings", () => {
  it("resolves NULL (the overwhelmingly common row state) to every default", () => {
    expect(resolveActionSecuritySettings(null)).toEqual({ ...DEFAULTS });
    expect(resolveActionSecuritySettings(undefined)).toEqual({ ...DEFAULTS });
  });

  it("defaults the three branch switches OFF and redaction ON", () => {
    const s = resolveActionSecuritySettings(null);
    expect(s.allowWebhooksOnBranches).toBe(false);
    expect(s.allowExternalCallFunctionsOnBranches).toBe(false);
    expect(s.allowNotificationsOnBranches).toBe(false);
    expect(s.disableNotificationRedaction).toBe(false);
  });

  it("defaults allowAutomateSubmission TRUE so pre-173 automations keep working", () => {
    expect(resolveActionSecuritySettings(null).allowAutomateSubmission).toBe(true);
  });

  it("defaults actionFailurePolicy to the strict 'all'", () => {
    expect(resolveActionSecuritySettings(null).actionFailurePolicy).toBe("all");
  });

  it("honours explicitly set values", () => {
    const s = resolveActionSecuritySettings({
      allowWebhooksOnBranches: true,
      allowNotificationsOnBranches: true,
      allowAutomateSubmission: false,
      actionFailurePolicy: "any",
      disableNotificationRedaction: true,
    });
    expect(s.allowWebhooksOnBranches).toBe(true);
    expect(s.allowNotificationsOnBranches).toBe(true);
    expect(s.allowAutomateSubmission).toBe(false);
    expect(s.actionFailurePolicy).toBe("any");
    expect(s.disableNotificationRedaction).toBe(true);
    // Unmentioned key still defaults.
    expect(s.allowExternalCallFunctionsOnBranches).toBe(false);
  });

  it("does NOT treat truthy non-booleans as true (a string 'false' must not enable a webhook)", () => {
    const s = resolveActionSecuritySettings({
      allowWebhooksOnBranches: "true",
      allowNotificationsOnBranches: 1,
    });
    expect(s.allowWebhooksOnBranches).toBe(false);
    expect(s.allowNotificationsOnBranches).toBe(false);
  });

  it("rejects an unknown failure policy back to 'all' rather than passing it through", () => {
    expect(
      resolveActionSecuritySettings({ actionFailurePolicy: "some" })
        .actionFailurePolicy,
    ).toBe("all");
    expect(
      resolveActionSecuritySettings({ actionFailurePolicy: null })
        .actionFailurePolicy,
    ).toBe("all");
  });

  it("never throws on a non-object blob — arrays, scalars, strings all resolve to defaults", () => {
    for (const raw of [[], [1, 2], 42, "settings", true, NaN]) {
      expect(() => resolveActionSecuritySettings(raw)).not.toThrow();
      expect(resolveActionSecuritySettings(raw)).toEqual({ ...DEFAULTS });
    }
  });

  it("returns a fresh object each call so a caller cannot mutate the frozen defaults", () => {
    const a = resolveActionSecuritySettings(null);
    a.allowWebhooksOnBranches = true;
    expect(resolveActionSecuritySettings(null).allowWebhooksOnBranches).toBe(false);
    expect(DEFAULTS.allowWebhooksOnBranches).toBe(false);
  });
});

describe("normalizeActionSecuritySettings", () => {
  it("collapses an all-defaults body to NULL so an untouched page stores nothing", () => {
    expect(normalizeActionSecuritySettings(null)).toBeNull();
    expect(normalizeActionSecuritySettings({})).toBeNull();
    expect(normalizeActionSecuritySettings({ ...DEFAULTS })).toBeNull();
  });

  it("returns a full object once any field diverges from its default", () => {
    const out = normalizeActionSecuritySettings({ allowWebhooksOnBranches: true });
    expect(out).not.toBeNull();
    expect(out!.allowWebhooksOnBranches).toBe(true);
    // Every other key is present and defaulted — the persisted blob is
    // complete, so a later default change cannot silently reinterpret it.
    expect(out!.allowAutomateSubmission).toBe(true);
    expect(out!.actionFailurePolicy).toBe("all");
  });

  it("drops unknown keys rather than letting arbitrary JSON into a security column", () => {
    const out = normalizeActionSecuritySettings({
      allowWebhooksOnBranches: true,
      __proto__pollution: "x",
      arbitrary: { deeply: { nested: true } },
    }) as unknown as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(
      (Object.keys(DEFAULTS) as string[]).sort(),
    );
  });

  it("a body that only sets defaults explicitly still normalizes to NULL", () => {
    expect(
      normalizeActionSecuritySettings({
        allowWebhooksOnBranches: false,
        allowAutomateSubmission: true,
      }),
    ).toBeNull();
  });
});

describe("isNonMainBranch", () => {
  const MAIN = "11111111-1111-1111-1111-111111111111";
  const BRANCH = "22222222-2222-2222-2222-222222222222";

  it("is true only when the resolved branch differs from main", () => {
    expect(isNonMainBranch(BRANCH, MAIN)).toBe(true);
    expect(isNonMainBranch(MAIN, MAIN)).toBe(false);
  });

  it("fails toward 'this is main' when main cannot be resolved", () => {
    // A transitional deployment with no ontology_branch row must keep
    // firing side effects exactly as it did before migration 173, rather
    // than silently suppressing all of them.
    expect(isNonMainBranch(BRANCH, null)).toBe(false);
    expect(isNonMainBranch(BRANCH, undefined)).toBe(false);
    expect(isNonMainBranch(null, MAIN)).toBe(false);
    expect(isNonMainBranch(undefined, undefined)).toBe(false);
    expect(isNonMainBranch("", MAIN)).toBe(false);
  });
});

describe("filterSideEffectsForBranch", () => {
  const settings = (over: Partial<ActionSecuritySettings> = {}) => ({
    ...DEFAULTS,
    ...over,
  });
  const blob = {
    webhooks: [{ url: "https://example.test/hook" }],
    notifications: [{ channel: "email", recipients: [{ principal: "a@b.c" }] }],
    other: "untouched",
  };

  it("returns the blob UNCHANGED on main — identity, so the non-branch path is byte-identical to pre-173", () => {
    expect(filterSideEffectsForBranch(blob, settings(), false)).toBe(blob);
  });

  it("empties both arrays on a branch under the defaults", () => {
    const out = filterSideEffectsForBranch(blob, settings(), true) as any;
    expect(out.webhooks).toEqual([]);
    expect(out.notifications).toEqual([]);
    // Unrelated keys survive.
    expect(out.other).toBe("untouched");
  });

  it("suppresses only webhooks when notifications are allowed on branches", () => {
    const out = filterSideEffectsForBranch(
      blob,
      settings({ allowNotificationsOnBranches: true }),
      true,
    ) as any;
    expect(out.webhooks).toEqual([]);
    expect(out.notifications).toHaveLength(1);
  });

  it("suppresses only notifications when webhooks are allowed on branches", () => {
    const out = filterSideEffectsForBranch(
      blob,
      settings({ allowWebhooksOnBranches: true }),
      true,
    ) as any;
    expect(out.webhooks).toHaveLength(1);
    expect(out.notifications).toEqual([]);
  });

  it("returns the blob unchanged on a branch when both switches are on", () => {
    expect(
      filterSideEffectsForBranch(
        blob,
        settings({
          allowWebhooksOnBranches: true,
          allowNotificationsOnBranches: true,
        }),
        true,
      ),
    ).toBe(blob);
  });

  it("never mutates the caller's blob", () => {
    filterSideEffectsForBranch(blob, settings(), true);
    expect(blob.webhooks).toHaveLength(1);
    expect(blob.notifications).toHaveLength(1);
  });

  it("passes through null/array blobs untouched (nothing to suppress)", () => {
    expect(filterSideEffectsForBranch(null, settings(), true)).toBeNull();
    const arr = [{ url: "x" }];
    expect(filterSideEffectsForBranch(arr, settings(), true)).toBe(arr);
  });
});
