// Unit tests for src/services/uploadProgress.ts — the Redis-backed progress
// store polled by the frontend during an in-flight upload. The `redis` module
// is mocked with an in-memory store so this runs offline (no Docker/Redis).

import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory redis mock shared across all tests in this file.
const store = new Map<string, string>();
const client = {
  on: () => {},
  connect: async () => {},
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => {
    store.set(k, v);
    return "OK";
  },
  del: async (k: string) => {
    store.delete(k);
    return 1;
  },
};
vi.mock("redis", () => ({
  default: { createClient: () => client },
  createClient: () => client,
}));

import { recordProgress, readProgress } from "../../src/services/uploadProgress";

describe("uploadProgress store", () => {
  beforeEach(() => store.clear());

  it("records and reads back progress", async () => {
    await recordProgress("u1", { phase: "s3", loaded: 100, total: 200, fileIndex: 0 });
    const p = await readProgress("u1");
    expect(p).not.toBeNull();
    expect(p!.loaded).toBe(100);
    expect(p!.total).toBe(200);
    expect(p!.phase).toBe("s3");
    expect(p!.fileIndex).toBe(0);
  });

  it("returns null for an unknown id", async () => {
    expect(await readProgress("does-not-exist")).toBeNull();
  });

  it("overwrites on update — latest progress wins (poll reads absolute state)", async () => {
    await recordProgress("u2", { loaded: 1, total: 10 });
    await recordProgress("u2", { loaded: 5, total: 10 });
    await recordProgress("u2", { loaded: 10, total: 10 });
    expect((await readProgress("u2"))?.loaded).toBe(10);
  });

  it("records a terminal status", async () => {
    await recordProgress("u3", { status: "done", loaded: 10, total: 10 });
    const p = await readProgress("u3");
    expect(p?.status).toBe("done");
  });

  it("records an error status with a message", async () => {
    await recordProgress("u4", { status: "error", message: "boom" });
    const p = await readProgress("u4");
    expect(p?.status).toBe("error");
    expect(p?.message).toBe("boom");
  });

  it("no-ops on an empty upload id", async () => {
    await recordProgress("", { loaded: 1, total: 2 });
    expect(await readProgress("")).toBeNull();
  });
});
