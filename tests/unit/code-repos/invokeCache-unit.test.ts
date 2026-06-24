// ---------------------------------------------------------------------------
// invokeCache — unit tests for the TTL+LRU cache that coalesces the function
// invoke burst. Pure logic; no DB / no server.
// ---------------------------------------------------------------------------
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTtlCache, transpileCacheKey } from "../../../src/services/codeRepository/admin/invokeCache";

describe("createTtlCache", () => {
  it("returns undefined for a miss and the value for a hit", () => {
    const c = createTtlCache<string, number>({});
    expect(c.get("a")).toBeUndefined();
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
  });

  it("treats omitted ttlMs as never-expiring (content-addressed)", () => {
    const c = createTtlCache<string, number>({ maxEntries: 4 });
    c.set("k", 99);
    // Far future — still present.
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now + 1_000_000);
    expect(c.get("k")).toBe(99);
    vi.useRealTimers();
  });

  it("evicts entries past their TTL", () => {
    vi.useFakeTimers();
    const base = 1_000;
    vi.setSystemTime(base);
    const c = createTtlCache<string, number>({ ttlMs: 5_000 });
    c.set("k", 7);
    expect(c.get("k")).toBe(7);
    vi.setSystemTime(base + 4_999);
    expect(c.get("k")).toBe(7);
    vi.setSystemTime(base + 5_001);
    expect(c.get("k")).toBeUndefined();
    vi.useRealTimers();
  });

  it("evicts the least-recently-used entry when the cap is exceeded", () => {
    const c = createTtlCache<string, number>({ maxEntries: 2 });
    c.set("a", 1);
    c.set("b", 2);
    // Touch "a" so "b" becomes the LRU candidate.
    expect(c.get("a")).toBe(1);
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined(); // evicted
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
  });

  it("refreshes the TTL on set of an existing key", () => {
    vi.useFakeTimers();
    const base = 2_000;
    vi.setSystemTime(base);
    const c = createTtlCache<string, number>({ ttlMs: 5_000, maxEntries: 4 });
    c.set("k", 1);
    vi.setSystemTime(base + 4_000);
    c.set("k", 2); // refresh
    vi.setSystemTime(base + 8_500); // 4.5s after the refresh
    expect(c.get("k")).toBe(2);
    vi.useRealTimers();
  });

  it("clear() drops all entries", () => {
    const c = createTtlCache<string, number>({});
    c.set("a", 1);
    c.set("b", 2);
    c.clear();
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBeUndefined();
  });
});

describe("transpileCacheKey", () => {
  it("is content-addressed: same (apiName, source) → same key", () => {
    expect(transpileCacheKey("fn", "return 1")).toBe(transpileCacheKey("fn", "return 1"));
  });
  it("differs when apiName or source differs", () => {
    expect(transpileCacheKey("fn", "return 1")).not.toBe(transpileCacheKey("fn", "return 2"));
    expect(transpileCacheKey("fn", "return 1")).not.toBe(transpileCacheKey("other", "return 1"));
  });
});
