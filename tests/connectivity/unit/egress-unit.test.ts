// Unit tests for the connection-open egress allowlist matcher.
import { afterEach, describe, it, expect } from "vitest";
import {
  isEgressAllowed,
  assertEgressAllowed,
  assertEgressForConfig,
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

describe("reserved-range SSRF guard (assertEgressForConfig)", () => {
  afterEach(() => {
    delete process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED;
  });

  it("blocks localhost by default (no allowance set)", () => {
    expect(() => assertEgressForConfig("localhost", 5432)).toThrowError(TellusError);
    try {
      assertEgressForConfig("localhost", 5432);
    } catch (e) {
      expect((e as TellusError).definition.errorName).toBe(
        "Tellus:Connectivity:EgressBlocked",
      );
    }
  });

  it("blocks reserved IPv4 literals and cloud-metadata by default", () => {
    expect(() => assertEgressForConfig("127.0.0.1", 5432)).toThrow();
    expect(() => assertEgressForConfig("10.1.2.3", 5432)).toThrow();
    expect(() => assertEgressForConfig("169.254.169.254", 80)).toThrow();
  });

  it("allows a public target", () => {
    expect(() => assertEgressForConfig("db.example.com", 5432)).not.toThrow();
    expect(() => assertEgressForConfig("8.8.8.8", 5432)).not.toThrow();
  });

  it("opts a reserved hostname back in when explicitly allowed", () => {
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "localhost";
    expect(() => assertEgressForConfig("localhost", 5432)).not.toThrow();
    expect(() => assertEgressForConfig("LOCALHOST", 5432)).not.toThrow();
    // A reserved target NOT on the allowlist is still blocked.
    expect(() => assertEgressForConfig("169.254.169.254", 80)).toThrow();
  });

  it("opts a loopback CIDR back in (covers the resolved IP)", () => {
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "127.0.0.1/8";
    expect(() => assertEgressForConfig("127.0.0.1", 5432)).not.toThrow();
    expect(() => assertEgressForConfig("127.9.9.9", 5432)).not.toThrow();
    // RFC-1918 outside the allowed CIDR remains blocked.
    expect(() => assertEgressForConfig("10.0.0.1", 5432)).toThrow();
  });

  it("treats a bare IPv4 entry as an exact (/32) allowance", () => {
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "127.0.0.1";
    expect(() => assertEgressForConfig("127.0.0.1", 5432)).not.toThrow();
    expect(() => assertEgressForConfig("127.0.0.2", 5432)).toThrow();
  });

  it("allows an IPv6 loopback literal when listed", () => {
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "::1";
    expect(() => assertEgressForConfig("::1", 5432)).not.toThrow();
    expect(() => assertEgressForConfig("[::1]", 5432)).not.toThrow();
  });

  it("re-parses when the env value changes (memo keyed on raw string)", () => {
    expect(() => assertEgressForConfig("localhost", 5432)).toThrow();
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "localhost";
    expect(() => assertEgressForConfig("localhost", 5432)).not.toThrow();
  });
});
