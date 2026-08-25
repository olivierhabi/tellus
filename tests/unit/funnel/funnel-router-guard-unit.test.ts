// ---------------------------------------------------------------------------
// Funnel router authorization guard — pure unit tests.
//
// Before this guard existed, every route in src/routes/funnel.ts was reachable
// by ANY authenticated principal, including one with an empty roles claim: an
// ontology *viewer* could flip a Quickwit index alias
// (POST /replacement/:objectType/approve-cutover), DROP retained indexes past
// their grace window (POST /replacement/sweep), issue ClickHouse DDL, or
// bootstrap Lakekeeper warehouses. None of that is recoverable by re-running
// the funnel. (OWASP API5, function-level authorization.)
//
// The live behaviour is already proven over real HTTP against a running server
// with real Keycloak tokens — viewer POST /replacement/sweep → 403 "Requires
// one of: ontology-admin", viewer POST /signals → 403 listing admin+editor,
// viewer GET /runs/... → 200, unauthenticated GET /metrics → 200. What that
// proof does NOT cover is the DISPATCH decision in isolation: which of the two
// middlewares a given method+path is routed to. That is the part a refactor can
// silently invert (e.g. by broadening the /signals carve-out to all POSTs, or
// by letting the admin default stop applying to a newly added route), and it is
// what this suite pins.
//
// The guard is invoked as PRODUCTION code — pulled off the real router's
// middleware stack — not reimplemented here. requireRole is mocked so the two
// authorities are distinguishable by name without needing Keycloak.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi, beforeEach } from "vitest";

/** Which authority each invocation resolved to. */
const decisions: string[] = [];

vi.mock("../../../src/middleware/requireRole", () => ({
  requireOntologyWrite: (_req: unknown, _res: unknown, next: () => void) => {
    decisions.push("ontology-write");
    next();
  },
  requireOntologyAdmin: (_req: unknown, _res: unknown, next: () => void) => {
    decisions.push("ontology-admin");
    next();
  },
  requireRole: (...roles: string[]) =>
    (_req: unknown, _res: unknown, next: () => void) => {
      decisions.push(`roles:${roles.join(",")}`);
      next();
    },
  dataPlaneGuard: (opts: { post?: string; get?: string }) =>
    (req: { method: string }, _res: unknown, next: () => void) => {
      decisions.push(`dataPlane:${req.method}:${opts.post ?? "none"}`);
      next();
    },
}));

import funnelRouter from "../../../src/routes/funnel";

type Layer = {
  name: string;
  handle: (req: unknown, res: unknown, next: (err?: unknown) => void) => void;
  route?: unknown;
  regexp?: RegExp;
};

/**
 * The router-level guard: the first stack layer that is plain middleware
 * (no `route`) and matches all paths. Reaching into the stack is deliberate —
 * the alternative is copying the dispatch logic into the test, which would
 * then pass even if production changed.
 */
function routerGuard(): Layer {
  const stack = (funnelRouter as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((l) => !l.route && l.handle.length === 3);
  expect(layer, "no router-level guard middleware found on the funnel router").toBeTruthy();
  return layer!;
}

/** Run the real guard for one method+path and report the authority chosen. */
function dispatch(method: string, path: string): { authority: string; nexted: boolean } {
  decisions.length = 0;
  let nexted = false;
  const req = { method, path, url: path, headers: {}, body: {}, params: {} };
  const res = {
    status: () => res,
    json: () => res,
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  routerGuard().handle(req, res, () => {
    nexted = true;
  });
  return { authority: decisions.join("|"), nexted };
}

beforeEach(() => {
  decisions.length = 0;
});

describe("funnel router guard — the /signals write carve-out", () => {
  it("routes POST /signals to ontology-write, not admin", () => {
    // Deliberate downgrade: /signals is the reindex trigger the Ontology
    // Manager datasources page fires on save. Admin-gating it would break the
    // normal editor workflow. It is idempotent, append-only into the signal
    // inbox, and scoped to one Object Type.
    const { authority, nexted } = dispatch("POST", "/signals");
    expect(authority).toBe("ontology-write");
    expect(nexted).toBe(true);
  });

  it("does NOT extend the carve-out to any other POST", () => {
    // The destructive endpoints the guard was written for.
    for (const path of [
      "/replacement/sweep",
      "/replacement/start",
      "/replacement/scheduler-tick",
      "/replacement/Taxpayer/approve-cutover",
      "/replacement/Taxpayer/rollback",
      "/replacement/Taxpayer/complete-backfill",
      "/clickhouse/link",
      "/clickhouse/link-cdc",
      "/clickhouse/refresh",
      "/lakekeeper/bootstrap",
      "/drain",
    ]) {
      expect(dispatch("POST", path).authority, `POST ${path}`).toBe("dataPlane:POST:admin");
    }
  });

  it("does not let a signals-prefixed or nested path inherit the carve-out", () => {
    // Exact-match only: a path that merely starts with /signals must not
    // borrow the lower authority.
    expect(dispatch("POST", "/signals/replay").authority).toBe("dataPlane:POST:admin");
    expect(dispatch("POST", "/signalsx").authority).toBe("dataPlane:POST:admin");
    expect(dispatch("POST", "/replacement/signals").authority).toBe("dataPlane:POST:admin");
  });

  it("does not apply the carve-out to a non-POST /signals", () => {
    // Only the POST verb was downgraded; anything else falls to the default.
    expect(dispatch("DELETE", "/signals").authority).toBe("dataPlane:DELETE:admin");
    expect(dispatch("PUT", "/signals").authority).toBe("dataPlane:PUT:admin");
  });
});

describe("funnel router guard — default authority for mutations", () => {
  it("admin-gates a POST path that does not exist yet", () => {
    // The property that makes this a router-level guard rather than per-route
    // annotations: the NEXT endpoint added to this file is admin-gated by
    // default, so authorization cannot be forgotten.
    expect(dispatch("POST", "/some/endpoint/added/tomorrow").authority).toBe(
      "dataPlane:POST:admin",
    );
  });

  it("passes every mutating verb through dataPlaneGuard", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(dispatch(method, "/replacement/start").authority).toBe(
        `dataPlane:${method}:admin`,
      );
    }
  });

  it("always calls next() so the guard never strands a request", () => {
    // The mocked authorities all call next(); what matters is that the guard
    // itself delegates on every branch rather than falling through silently.
    for (const [m, p] of [
      ["POST", "/signals"],
      ["POST", "/replacement/sweep"],
      ["GET", "/metrics"],
    ] as const) {
      expect(dispatch(m, p).nexted, `${m} ${p}`).toBe(true);
    }
  });
});

describe("funnel router guard — reads pass to the data-plane guard", () => {
  it("hands GET/HEAD/OPTIONS to dataPlaneGuard rather than a write authority", () => {
    // Reads are governed by the marking/security context in the handlers, and
    // GET /metrics is deliberately unauthenticated for Prometheus scraping.
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const { authority } = dispatch(method, "/metrics");
      expect(authority).toBe(`dataPlane:${method}:admin`);
      expect(authority).not.toContain("ontology-write");
      expect(authority).not.toContain("ontology-admin");
    }
  });

  it("treats funnel read endpoints uniformly", () => {
    for (const path of [
      "/runs/Taxpayer",
      "/snapshots",
      "/instances/Taxpayer/pk-1",
      "/overlay/Taxpayer/pk-1",
      "/slis",
      "/slis/metrics",
      "/lakekeeper/info",
      "/replacement/Taxpayer/preview-cutover",
      "/clickhouse/cdc-lag",
    ]) {
      expect(dispatch("GET", path).authority, `GET ${path}`).toBe("dataPlane:GET:admin");
    }
  });

  it("invokes exactly one authority per request — no double-charging", () => {
    dispatch("POST", "/signals");
    expect(decisions).toHaveLength(1);
    dispatch("POST", "/replacement/sweep");
    expect(decisions).toHaveLength(1);
  });
});
