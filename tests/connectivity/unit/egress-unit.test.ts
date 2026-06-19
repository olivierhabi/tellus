// Unit tests for the connection-open egress allowlist matcher.
import { describe, it, expect } from "vitest";
import {
  isEgressAllowed,
  assertEgressAllowed,
} from "../../../src/services/connectivity/connectors/postgresql/egress";
import { TellusError } from "../../../src/lib/errors/envelope";

describe("connectivity egress allowlist", () => {
  it("allows an exact host:port match (case-insensitive)", () => {
    const policy = { allowlist: [{ kind: "host" as const, host: "DB.example.com", port: 5432 }] };
    expect(isEgressAllowed("db.example.com", 5432, policy)).toBe(true);
  });

  it("blocks when the port differs", () => {
    const policy = { allowlist: [{ kind: "host" as const, host: "db.example.com", port: 5432 }] };
    expect(isEgressAllowed("db.example.com", 5433, policy)).toBe(false);
  });

  it("blocks when the host differs", () => {
    const policy = { allowlist: [{ kind: "host" as const, host: "db.example.com", port: 5432 }] };
    expect(isEgressAllowed("evil.example.com", 5432, policy)).toBe(false);
  });

  it("allows a literal IPv4 inside a CIDR entry", () => {
    const policy = { allowlist: [{ kind: "cidr" as const, cidr: "10.0.0.0/8", port: 5432 }] };
    expect(isEgressAllowed("10.1.2.3", 5432, policy)).toBe(true);
    expect(isEgressAllowed("11.1.2.3", 5432, policy)).toBe(false);
  });

  it("does not match a hostname against a CIDR entry (no DNS resolution here)", () => {
    const policy = { allowlist: [{ kind: "cidr" as const, cidr: "10.0.0.0/8", port: 5432 }] };
    expect(isEgressAllowed("db.example.com", 5432, policy)).toBe(false);
  });

  it("blocks an empty or missing allowlist", () => {
    expect(isEgressAllowed("db.example.com", 5432, { allowlist: [] })).toBe(false);
    expect(isEgressAllowed("db.example.com", 5432, null)).toBe(false);
    expect(isEgressAllowed("db.example.com", 5432, undefined)).toBe(false);
  });

  it("handles /0 (allow-all) and /32 (single host) masks", () => {
    expect(isEgressAllowed("8.8.8.8", 443, { allowlist: [{ kind: "cidr", cidr: "0.0.0.0/0", port: 443 }] })).toBe(true);
    expect(isEgressAllowed("192.168.1.10", 5432, { allowlist: [{ kind: "cidr", cidr: "192.168.1.10/32", port: 5432 }] })).toBe(true);
    expect(isEgressAllowed("192.168.1.11", 5432, { allowlist: [{ kind: "cidr", cidr: "192.168.1.10/32", port: 5432 }] })).toBe(false);
  });

  it("assertEgressAllowed throws EgressBlocked for an unlisted target", () => {
    expect(() =>
      assertEgressAllowed("ri.magritte.main.source.x", "evil.example.com", 5432, { allowlist: [] }),
    ).toThrowError(TellusError);
    try {
      assertEgressAllowed("ri.magritte.main.source.x", "evil.example.com", 5432, { allowlist: [] });
    } catch (e) {
      expect((e as TellusError).definition.errorName).toBe("Tellus:Connectivity:EgressBlocked");
    }
  });

  it("assertEgressAllowed is a no-op for a permitted target", () => {
    expect(() =>
      assertEgressAllowed(
        "ri.magritte.main.source.x",
        "db.example.com",
        5432,
        { allowlist: [{ kind: "host", host: "db.example.com", port: 5432 }] },
      ),
    ).not.toThrow();
  });
});
