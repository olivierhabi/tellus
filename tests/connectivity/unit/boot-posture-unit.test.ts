// Hermetic unit coverage for the connectivity production posture gate.
//
// The whole value of this gate is that a dev-only egress escape hatch cannot
// reach production silently, so these cases pin the exact matrix: dev is never
// blocked, production without the variable is clean, production WITH it refuses
// to boot, and the explicit override downgrades to a loud warning.

import { describe, expect, it } from "vitest";
import {
  assertConnectivityPosture,
  evaluateConnectivityPosture,
} from "../../../src/services/connectivity/bootPosture";

describe("connectivity boot posture", () => {
  it("allows development with the reserved-range escape hatch set", () => {
    // This is the normal local .env — must never be flagged.
    expect(
      evaluateConnectivityPosture({
        NODE_ENV: "development",
        CONNECTIVITY_EGRESS_ALLOW_RESERVED: "localhost,127.0.0.1/8,::1",
      }),
    ).toEqual([]);
  });

  it("allows production when the escape hatch is unset", () => {
    expect(evaluateConnectivityPosture({ NODE_ENV: "production" })).toEqual([]);
  });

  it("treats an all-whitespace value as unset", () => {
    expect(
      evaluateConnectivityPosture({
        NODE_ENV: "production",
        CONNECTIVITY_EGRESS_ALLOW_RESERVED: "   ",
      }),
    ).toEqual([]);
  });

  it("refuses production boot when the SSRF guard is disabled", () => {
    const issues = evaluateConnectivityPosture({
      NODE_ENV: "production",
      CONNECTIVITY_EGRESS_ALLOW_RESERVED: "127.0.0.1/8",
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("fatal");
    expect(issues[0].message).toContain("Production start refused");
    // The offending value must appear so the operator can find the config.
    expect(issues[0].message).toContain("127.0.0.1/8");
  });

  it("downgrades to a warning under the explicit production override", () => {
    const issues = evaluateConnectivityPosture({
      NODE_ENV: "production",
      CONNECTIVITY_EGRESS_ALLOW_RESERVED: "10.4.0.0/16",
      CONNECTIVITY_ALLOW_RESERVED_IN_PRODUCTION: "1",
    });
    expect(issues.map((i) => i.severity)).toEqual(["warn"]);
    expect(issues[0].message).toContain("10.4.0.0/16");
  });

  it("warns when worker leader election is bypassed in production", () => {
    const issues = evaluateConnectivityPosture({
      NODE_ENV: "production",
      TELLUS_CONNECTIVITY_WORKER_LEASE: "0",
    });
    expect(issues.map((i) => i.severity)).toEqual(["warn"]);
    expect(issues[0].message).toContain("leader election is DISABLED");
  });

  it("assertConnectivityPosture throws on fatal, returns on warn", () => {
    expect(() =>
      assertConnectivityPosture({
        NODE_ENV: "production",
        CONNECTIVITY_EGRESS_ALLOW_RESERVED: "169.254.0.0/16",
      }),
    ).toThrow(/Production start refused/);

    expect(() =>
      assertConnectivityPosture({
        NODE_ENV: "production",
        TELLUS_CONNECTIVITY_WORKER_LEASE: "0",
      }),
    ).not.toThrow();
  });
});
