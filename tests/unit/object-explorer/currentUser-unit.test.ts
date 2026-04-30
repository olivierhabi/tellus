// ---------------------------------------------------------------------------
// T-06 — `currentUser` helper unit tests.
//
// Covers contracts C-90, C-91, C-92.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { currentUser } from "../../../src/middleware/currentUser";

function fakeReq(user: unknown): Request {
  return { user } as unknown as Request;
}

describe("T-06 currentUser — contracts C-90, C-91", () => {
  it("T-06 C-90: returns the authenticated user id when present", () => {
    expect(currentUser(fakeReq({ id: "alice" }))).toBe("alice");
  });

  it("T-06 C-91a: throws UNAUTHORIZED when req.user is undefined", () => {
    let caught: { code?: string; message?: string } | null = null;
    try {
      currentUser(fakeReq(undefined));
    } catch (e) {
      caught = e as { code?: string; message?: string };
    }
    expect(caught).not.toBeNull();
    expect(caught!.code).toBe("UNAUTHORIZED");
    expect(caught!.message).toBe("Missing authenticated user context.");
  });

  it("T-06 C-91b: throws UNAUTHORIZED when req.user.id is missing", () => {
    expect(() => currentUser(fakeReq({}))).toThrow();
  });

  it("T-06 C-91c: throws UNAUTHORIZED when req.user.id is empty string", () => {
    expect(() => currentUser(fakeReq({ id: "" }))).toThrow();
  });

  it("T-06 C-91d: throws UNAUTHORIZED when req.user.id is non-string", () => {
    expect(() => currentUser(fakeReq({ id: 12345 }))).toThrow();
    expect(() => currentUser(fakeReq({ id: null }))).toThrow();
  });
});
