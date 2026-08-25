// Unit tests for mapPgError (handlers/test.handler.ts).
//
// Regression pin for the errno-vs-code bug: Node syscall errors carry the
// string identifier ("ECONNREFUSED") in `code` while `errno` is the NUMERIC
// constant (-61). The original mapping matched `errno === "ECONNREFUSED"`,
// which never fired, so every network failure fell through to the generic
// 500 handler instead of the designed 502 JdbcConnectFailed. These tests use
// REAL driver-shaped error objects (numeric errno) to keep that pinned.
import { describe, it, expect } from "vitest";
import { mapPgError } from "../../../src/services/connectivity/handlers/test.handler";

/** Shape of an actual Node net error (verified: errno is a number). */
function netError(code: string, errno: number, message: string) {
  return Object.assign(new Error(message), { code, errno, syscall: "connect" });
}

describe("mapPgError — network failures (code-based, numeric errno)", () => {
  it("maps ECONNREFUSED to connect / connection refused", () => {
    const e = netError("ECONNREFUSED", -61, "connect ECONNREFUSED ::1:5432");
    expect(mapPgError(e)).toEqual({
      kind: "connect",
      reason: "connection refused",
    });
  });

  it("maps ENOTFOUND to connect / host not resolvable", () => {
    const e = netError("ENOTFOUND", -3008, "getaddrinfo ENOTFOUND nope.invalid");
    expect(mapPgError(e)).toEqual({
      kind: "connect",
      reason: "host not resolvable",
    });
  });

  it("maps ETIMEDOUT to connect / connect timeout", () => {
    const e = netError("ETIMEDOUT", -60, "connect ETIMEDOUT 10.1.2.3:5432");
    expect(mapPgError(e)).toEqual({
      kind: "connect",
      reason: "connect timeout",
    });
  });

  it("maps EHOSTUNREACH / ENETUNREACH / ECONNRESET to connect", () => {
    for (const code of ["EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"]) {
      expect(mapPgError(netError(code, -1, `${code} x`)).kind).toBe("connect");
    }
  });
});

describe("mapPgError — auth and TLS", () => {
  it("maps 28P01 (invalid_password) to auth", () => {
    const e = Object.assign(new Error("password authentication failed"), {
      code: "28P01",
    });
    expect(mapPgError(e)).toEqual({
      kind: "auth",
      reason: "credentials rejected",
    });
  });

  it("maps 28000 (invalid_authorization_specification) to auth", () => {
    const e = Object.assign(new Error("no pg_hba.conf entry"), { code: "28000" });
    expect(mapPgError(e).kind).toBe("auth");
  });

  it("maps self-signed certificate message to connect / tls self-signed", () => {
    const e = new Error("self-signed certificate in certificate chain");
    expect(mapPgError(e)).toEqual({ kind: "connect", reason: "tls self-signed" });
  });

  it("maps generic certificate failure to connect / tls certificate invalid", () => {
    const e = new Error("unable to verify the first certificate");
    expect(mapPgError(e).reason).toBe("tls certificate invalid");
  });
});

describe("mapPgError — fallthrough", () => {
  it("leaves unknown errors as other (routed to next())", () => {
    expect(mapPgError(new Error("something else"))).toEqual({
      kind: "other",
      reason: "unknown",
    });
    expect(mapPgError(undefined).kind).toBe("other");
  });
});
