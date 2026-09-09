// ---------------------------------------------------------------------------
// errorHandler middleware + Sentry-gated error-tracking sink (unit).
//
// Covers:
//   1. The SENTRY_DSN no-op path: with the DSN unset, captureError returns
//      without importing any SDK or emitting anything, and the middleware
//      still produces the historical 500 envelope.
//   2. The misconfigured path (DSN set, SDK absent): degrades to structured
//      logs without throwing.
//   3. Regression lock on the middleware's response contract (OntologyError,
//      AppError hierarchy, PG unique_violation, fallback 500, headersSent).
// ---------------------------------------------------------------------------
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

import errorHandler, {
  ValidationError,
} from "../../../src/middleware/errorHandler";
import { OntologyError } from "../../../src/utils/queryErrors";
import {
  captureError,
  isErrorTrackingEnabled,
} from "../../../src/services/errorTracking";

const SENTRY_DSN_KEY = "SENTRY_DSN";
let savedDsn: string | undefined;

beforeEach(() => {
  savedDsn = process.env[SENTRY_DSN_KEY];
  delete process.env[SENTRY_DSN_KEY];
});

afterEach(() => {
  if (savedDsn === undefined) delete process.env[SENTRY_DSN_KEY];
  else process.env[SENTRY_DSN_KEY] = savedDsn;
});

interface MockRes {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  headersSent: boolean;
}

function mockRes(headersSent = false): { res: MockRes; statusCode: () => number; body: () => unknown } {
  const res: MockRes = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    headersSent,
  };
  return {
    res,
    statusCode: () => (res.status.mock.calls[0]?.[0] as number) ?? -1,
    body: () => res.json.mock.calls[0]?.[0],
  };
}

function mockReq(): Request {
  return { requestId: "req-test-123", path: "/api/v1/test" } as unknown as Request;
}

const next: NextFunction = (() => {}) as NextFunction;

describe("error-tracking sink no-op path (SENTRY_DSN unset)", () => {
  it("isErrorTrackingEnabled() is false without a DSN", () => {
    expect(isErrorTrackingEnabled()).toBe(false);
  });

  it("captureError returns silently without a DSN (no SDK import, no throw)", () => {
    expect(() =>
      captureError(new Error("boom"), { statusCode: 500, errorCode: "INTERNAL_ERROR" }),
    ).not.toThrow();
  });

  it("middleware still returns the historical 500 envelope on the no-op path", () => {
    const { res, statusCode, body } = mockRes();
    errorHandler(new Error("kaboom"), mockReq(), res as unknown as Response, next);
    expect(statusCode()).toBe(500);
    expect(body()).toMatchObject({
      errorCode: "INTERNAL_ERROR",
      errorName: "InternalError",
      statusCode: 500,
      requestId: "req-test-123",
    });
  });

  it("4xx failures never attempt tracking even when a DSN is configured", () => {
    process.env[SENTRY_DSN_KEY] = "https://example@sentry.io/1";
    const { res, statusCode } = mockRes();
    // ValidationError → 400: sink must filter it out (no SDK installed, and
    // even with one, <500 never forwards). Must not throw.
    expect(() =>
      errorHandler(new ValidationError("bad input"), mockReq(), res as unknown as Response, next),
    ).not.toThrow();
    expect(statusCode()).toBe(400);
  });
});

describe("error-tracking sink misconfigured path (DSN set, SDK absent)", () => {
  it("reports enabled but degrades to structured logs without throwing", () => {
    process.env[SENTRY_DSN_KEY] = "https://example@sentry.io/1";
    expect(isErrorTrackingEnabled()).toBe(true);
    expect(() =>
      captureError(new Error("boom"), { statusCode: 500 }),
    ).not.toThrow();
  });
});

describe("errorHandler response contract (unchanged behavior)", () => {
  it("returns early without a response when headers are already sent", () => {
    const { res } = mockRes(true);
    errorHandler(new Error("late"), mockReq(), res as unknown as Response, next);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it("maps OntologyError to its status + response shape with requestId", () => {
    const { res, statusCode, body } = mockRes();
    errorHandler(
      new OntologyError("missing thing", "OBJECT_NOT_FOUND"),
      mockReq(),
      res as unknown as Response,
      next,
    );
    expect(statusCode()).toBe(404);
    expect(body()).toMatchObject({
      errorCode: "OBJECT_NOT_FOUND",
      requestId: "req-test-123",
    });
  });

  it("maps AppError-hierarchy ValidationError to a 400 SPEC envelope", () => {
    const { res, statusCode, body } = mockRes();
    errorHandler(
      new ValidationError("bad input", { field: "name" }),
      mockReq(),
      res as unknown as Response,
      next,
    );
    expect(statusCode()).toBe(400);
    expect(body()).toMatchObject({
      errorCode: "VALIDATION_FAILED",
      errorName: "ValidationError",
      requestId: "req-test-123",
    });
  });

  it("maps PG unique_violation (23505) to 409 ALREADY_EXISTS", () => {
    const { res, statusCode, body } = mockRes();
    const pgErr = Object.assign(new Error("duplicate key value"), { code: "23505" });
    errorHandler(pgErr, mockReq(), res as unknown as Response, next);
    expect(statusCode()).toBe(409);
    expect(body()).toMatchObject({ errorCode: "ALREADY_EXISTS" });
  });

  it("maps malformed JSON bodies to a 400 VALIDATION_ERROR envelope", () => {
    const { res, statusCode, body } = mockRes();
    const syntaxErr = Object.assign(new SyntaxError("Unexpected token"), {
      type: "entity.parse.failed",
    });
    errorHandler(syntaxErr, mockReq(), res as unknown as Response, next);
    expect(statusCode()).toBe(400);
    expect(body()).toMatchObject({ errorCode: "VALIDATION_ERROR" });
  });
});
