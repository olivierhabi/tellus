import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  DEFAULT_TENANT,
  resolveRequestTenant,
} from "../../../src/utils/requestTenant";

describe("resolveRequestTenant", () => {
  it("reads the verified JWT tenant claim from req.auth", () => {
    const req = { auth: { tenant: "tenant-b" } } as unknown as Request;
    expect(resolveRequestTenant(req)).toBe("tenant-b");
  });

  it("does not trust a caller-supplied tenant header", () => {
    const req = {
      headers: { "x-tellus-tenant": "tenant-b" },
    } as unknown as Request;
    expect(resolveRequestTenant(req)).toBe(DEFAULT_TENANT);
  });

  it("prefers the normalized authenticated user when present", () => {
    const req = {
      user: { tenant: "tenant-a" },
      auth: { tenant: "tenant-b" },
    } as unknown as Request;
    expect(resolveRequestTenant(req)).toBe("tenant-a");
  });
});
