/**
 * B5 — Deadline unit tests.
 *
 * Contracts covered:
 *   B5 C-09 — X-Deadline parsing, remaining-budget propagation, boundary
 *             enforcement (DEADLINE_EXCEEDED at the boundary, not at
 *             completion).
 *   G-06   — every compute path accepts X-Deadline.
 */

import { describe, it, expect } from "vitest";
import {
  parseDeadlineHeader,
  deadlineFromBudget,
  remainingMs,
  assertBudget,
  withDeadline,
  DeadlineExceededError,
} from "../../../src/services/quiver/compute/deadline";

const T0 = Date.parse("2026-05-04T00:00:00Z");

describe("B5 C-09 / G-06: parseDeadlineHeader", () => {
  it("parses ISO instant", () => {
    const d = parseDeadlineHeader("2026-05-04T00:00:01Z", T0);
    expect(d).not.toBeNull();
    expect(d!.deadlineEpochMs).toBe(T0 + 1000);
    expect(d!.initialBudgetMs).toBe(1000);
  });

  it("returns null for empty/missing header", () => {
    expect(parseDeadlineHeader(undefined, T0)).toBeNull();
    expect(parseDeadlineHeader("", T0)).toBeNull();
    expect(parseDeadlineHeader("   ", T0)).toBeNull();
  });

  it("throws on garbage", () => {
    expect(() => parseDeadlineHeader("not-a-date", T0)).toThrow();
  });
});

describe("B5 C-09: deadlineFromBudget", () => {
  it("computes deadline from positive budget", () => {
    const d = deadlineFromBudget(500, T0);
    expect(remainingMs(d, T0)).toBe(500);
    expect(remainingMs(d, T0 + 200)).toBe(300);
  });

  it("rejects negative budgets", () => {
    expect(() => deadlineFromBudget(-1, T0)).toThrow();
    expect(() => deadlineFromBudget(NaN, T0)).toThrow();
  });
});

describe("B5 C-09: assertBudget at the boundary", () => {
  it("throws DeadlineExceededError when remaining < required", () => {
    const d = deadlineFromBudget(100, T0);
    expect(() => assertBudget(d, 200, T0)).toThrow(DeadlineExceededError);
  });

  it("passes when remaining >= required", () => {
    const d = deadlineFromBudget(500, T0);
    expect(() => assertBudget(d, 100, T0)).not.toThrow();
  });
});

describe("B5 C-09: withDeadline races backend vs deadline", () => {
  it("returns DEADLINE_EXCEEDED at the boundary, not at backend completion", async () => {
    // Backend stub sleeps 200 ms; deadline budget 100 ms.
    const d = deadlineFromBudget(100, Date.now());
    const start = Date.now();
    let err: unknown;
    try {
      await withDeadline(d, async () => {
        await new Promise((r) => setTimeout(r, 200));
        return "done";
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(DeadlineExceededError);
    // Boundary enforcement: must return within ~150 ms wall, not 200+
    expect(elapsed).toBeLessThan(180);
  });

  it("returns backend result when within budget", async () => {
    const d = deadlineFromBudget(500, Date.now());
    const r = await withDeadline(d, async () => {
      await new Promise((r) => setTimeout(r, 50));
      return 42;
    });
    expect(r).toBe(42);
  });
});
