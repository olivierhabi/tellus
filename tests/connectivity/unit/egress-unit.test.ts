// Unit tests for the connection-open egress allowlist matcher.
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  isEgressAllowed,
  assertEgressAllowed,
  assertEgressForConfig,
  assertReservedTargetRequiresApprovedPolicy,
  isTrulyReservedTarget,
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
  beforeEach(() => {
    // tests/globalSetup.ts pins CONNECTIVITY_EGRESS_ALLOW_RESERVED for the
    // lane server; workers inherit the parent env, so this file must
    // actively clear it to assert the stock deny-by-default behaviour.
    delete process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED;
  });
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

describe("truly-reserved targets ignore the operator opt-in", () => {
  beforeEach(() => {
    delete process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED;
  });
  afterEach(() => {
    delete process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED;
  });

  it("stays reserved even when the env opt-in allowlists loopback", () => {
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "localhost,127.0.0.1/8,::1";
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.9.9.9",
      "::1",
      "10.1.2.3",
      "192.168.1.1",
      "169.254.169.254",
      "metadata.google.internal",
      "fc00::1",
      "fe80::1",
    ]) {
      expect(isTrulyReservedTarget(host)).toBe(true);
    }
  });

  it("never flags public targets, with or without the opt-in", () => {
    expect(isTrulyReservedTarget("db.example.com")).toBe(false);
    expect(isTrulyReservedTarget("8.8.8.8")).toBe(false);
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "localhost,127.0.0.1/8,::1";
    expect(isTrulyReservedTarget("db.example.com")).toBe(false);
    expect(isTrulyReservedTarget("8.8.8.8")).toBe(false);
    expect(isTrulyReservedTarget("172.32.0.1")).toBe(false);
  });
});

describe("reserved registration gate (assertReservedTargetRequiresApprovedPolicy)", () => {
  beforeEach(() => {
    delete process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED;
  });
  afterEach(() => {
    delete process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED;
  });

  function egressBlockedError(fn: () => void): TellusError {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(TellusError);
      expect((e as TellusError).definition.errorName).toBe(
        "Tellus:Connectivity:EgressBlocked",
      );
      expect((e as TellusError).definition.httpStatus).toBe(403);
      return e as TellusError;
    }
    throw new Error("expected EgressBlocked, but the gate passed");
  }

  it("reserved + inline-only (no named policy) → 403, even with the env opt-in set", () => {
    // The env opt-in must never self-authorize a persisted connection: the
    // gate evaluates the target IGNORING it.
    process.env.CONNECTIVITY_EGRESS_ALLOW_RESERVED = "localhost,127.0.0.1/8,::1";
    egressBlockedError(() =>
      assertReservedTargetRequiresApprovedPolicy("localhost", 5432, null),
    );
    egressBlockedError(() =>
      assertReservedTargetRequiresApprovedPolicy("127.0.0.1", 5432, {
        egressPolicyRid: null,
        policyStatus: null,
      }),
    );
  });

  it("reserved + PENDING / REJECTED / unknown named policy → 403", () => {
    const rid = "ri.magritte.main.egress-policy.12345678-1234-1234-1234-123456789012";
    for (const policyStatus of ["PENDING", "REJECTED", null]) {
      egressBlockedError(() =>
        assertReservedTargetRequiresApprovedPolicy("127.0.0.1", 5432, {
          egressPolicyRid: rid,
          policyStatus,
        }),
      );
    }
    // RID present but unresolvable (null status) also fails closed.
    egressBlockedError(() =>
      assertReservedTargetRequiresApprovedPolicy("10.0.0.1", 5432, {
        egressPolicyRid: rid,
        policyStatus: null,
      }),
    );
  });

  it("reserved + APPROVED named policy → allowed (laptop loopback flow)", () => {
    const rid = "ri.magritte.main.egress-policy.12345678-1234-1234-1234-123456789012";
    expect(() =>
      assertReservedTargetRequiresApprovedPolicy("localhost", 5432, {
        egressPolicyRid: rid,
        policyStatus: "APPROVED",
      }),
    ).not.toThrow();
    expect(() =>
      assertReservedTargetRequiresApprovedPolicy("127.0.0.1", 5432, {
        egressPolicyRid: rid,
        policyStatus: "APPROVED",
      }),
    ).not.toThrow();
  });

  it("non-reserved + inline-only (no named policy) → allowed", () => {
    expect(() =>
      assertReservedTargetRequiresApprovedPolicy("db.example.com", 5432, null),
    ).not.toThrow();
    expect(() =>
      assertReservedTargetRequiresApprovedPolicy("8.8.8.8", 5432, {
        egressPolicyRid: null,
        policyStatus: null,
      }),
    ).not.toThrow();
  });
});
