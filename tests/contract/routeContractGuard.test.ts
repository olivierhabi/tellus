// ---------------------------------------------------------------------------
// T-10 — Route contract guard (AST-level).
//
// Walks the explorer route files with the TypeScript compiler API and
// asserts that EVERY router-mounted handler invokes the canonical
// observability + security trio:
//
//   * `buildSecurityFilter(`  — markings/CBAC enforcement
//   * `readBranchHeader(`     — branch context propagation
//   * `routeMetric(`          — uniform RED metric per spec
//
// Contracts covered:
//   C-200 Every read-shaped handler in the explorer surface invokes
//         buildSecurityFilter + readBranchHeader + routeMetric.
//   C-201 EXEMPT_LIST is a closed-form allowlist; adding an entry
//         requires the file::handler key AND a justification comment in
//         the `EXEMPT_REASONS` map below (so reviewers can audit
//         exemptions in one place).
//   C-202 The `RouteName` type union enumerates every concrete
//         `routeMetric(req, "<route>", ...)` literal observed in the
//         routes — no orphan literals, no unreferenced names.
//
// This guard is intentionally strict. A new explorer handler that
// forgets the trio fails CI before it ever ships.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";

// Files under guard. Adding a new file requires either fully wiring its
// handlers or recording a per-handler exemption.
const ROUTE_FILES = [
  "src/routes/objects.ts",
  "src/routes/objectViews.ts",
  "src/routes/charts.ts",
  "src/routes/sql.ts",
  "src/routes/summary.ts",
  "src/routes/comparisons.ts",
  "src/routes/explorations.ts",
  "src/routes/favorites.ts",
  "src/routes/exports.ts",
];

// Handlers that legitimately do NOT call buildSecurityFilter +
// readBranchHeader. Each entry is `<file>::<canonical-handler-name>`.
// The key MUST appear in EXEMPT_REASONS or the test fails.
//
// Naming: handlers are identified by the route mount path encoded as
// `<METHOD>:<PATH>` so URL collisions across files cannot happen.
const EXEMPT_LIST: ReadonlyArray<string> = [
  // favorites.* are user-scoped writes/reads of the caller's own
  // bookmarks. Markings + branch don't apply (a favorite has no
  // marking-controlled content).
  'src/routes/favorites.ts::POST:/',
  'src/routes/favorites.ts::DELETE:/:resourceType/:resourceId',
  'src/routes/favorites.ts::GET:/',
  'src/routes/favorites.ts::POST:/recent',
  'src/routes/favorites.ts::GET:/recent',
  // explorations.* are PG-direct CRUD whose security model is a
  // marking-set match in the SQL predicate (`required_markings <@ $`).
  // The OS security filter does not apply.
  'src/routes/explorations.ts::POST:/',
  'src/routes/explorations.ts::GET:/',
  'src/routes/explorations.ts::GET:/:id',
  'src/routes/explorations.ts::PUT:/:id',
  'src/routes/explorations.ts::DELETE:/:id',
  // exports.create captures the security context as a snapshot via
  // `requireSecurityContext` (stricter than buildSecurityFilter — it
  // throws when context is missing) and persists the snapshot to the
  // job row; the worker reads that snapshot at execution time. The
  // OS security filter is built from the snapshot inside the worker.
  'src/routes/exports.ts::POST:/',
  // exports.list/get/download are user-scoped reads of the caller's
  // own export jobs (`requested_by = $userId` — IDOR-safe). The OS
  // security filter is captured at create-time as a snapshot column.
  'src/routes/exports.ts::GET:/',
  'src/routes/exports.ts::GET:/:jobId',
  'src/routes/exports.ts::GET:/:jobId/download',
  // sql.invalidate is admin-only via authorize('ontology-admin') and
  // does not read tenant data.
  'src/routes/sql.ts::POST:/sql/invalidate',
] as const;

const EXEMPT_REASONS: Record<string, string> = {
  'src/routes/favorites.ts::POST:/':
    'User-scoped write of caller\'s own bookmark. No markings.',
  'src/routes/favorites.ts::DELETE:/:resourceType/:resourceId':
    'User-scoped delete of caller\'s own bookmark.',
  'src/routes/favorites.ts::GET:/':
    'User-scoped read of caller\'s own bookmarks.',
  'src/routes/favorites.ts::POST:/recent':
    'User-scoped write of caller\'s own visit history.',
  'src/routes/favorites.ts::GET:/recent':
    'User-scoped read of caller\'s own visit history.',
  'src/routes/explorations.ts::POST:/':
    'PG-direct write; markings enforced via required_markings column.',
  'src/routes/explorations.ts::GET:/':
    'PG-direct read; markings enforced via required_markings <@ predicate.',
  'src/routes/explorations.ts::GET:/:id':
    'PG-direct read; markings enforced via required_markings <@ predicate.',
  'src/routes/explorations.ts::PUT:/:id':
    'PG-direct write; markings re-resolved on config change.',
  'src/routes/explorations.ts::DELETE:/:id':
    'PG-direct delete scoped to owner_id = currentUser.',
  'src/routes/exports.ts::POST:/':
    'requireSecurityContext snapshots the principal; worker rebuilds the OS security filter from the snapshot column at execution time.',
  'src/routes/exports.ts::GET:/':
    'User-scoped read of caller\'s own jobs (requested_by = currentUser).',
  'src/routes/exports.ts::GET:/:jobId':
    'User-scoped read; IDOR-safe via requested_by = currentUser.',
  'src/routes/exports.ts::GET:/:jobId/download':
    'User-scoped download; IDOR-safe via requested_by = currentUser.',
  'src/routes/sql.ts::POST:/sql/invalidate':
    'Admin-only via authorize(\'ontology-admin\'). No tenant data read.',
};

// ---------------------------------------------------------------------------
// AST walker — collect (file, method, path, body-text) for every router
// handler call.
// ---------------------------------------------------------------------------

interface HandlerInfo {
  file: string;
  method: string;
  routePath: string;
  bodyText: string;
}

function collectHandlers(filePath: string): HandlerInfo[] {
  const source = fs.readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const out: HandlerInfo[] = [];

  function visit(node: ts.Node): void {
    // Match any identifier that is exactly `router` OR ends in `Router`
    // (e.g. `objectViewsByTypeRouter`). The trailing-`Router` convention
    // is the codebase-wide pattern for sub-routers mounted under a
    // parent path.
    const isRouterCall =
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "router" ||
        /Router$/.test(node.expression.expression.text));
    if (isRouterCall) {
      const method = node.expression.name.text.toUpperCase();
      if (
        ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) &&
        node.arguments.length >= 2
      ) {
        const first = node.arguments[0];
        if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
          const routePath = first.text;
          // The handler is the LAST argument (skip middleware like authorize()).
          const handlerArg = node.arguments[node.arguments.length - 1];
          const bodyText = handlerArg.getText(sf);
          out.push({
            file: filePath,
            method,
            routePath,
            bodyText,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return out;
}

function keyFor(h: HandlerInfo): string {
  return `${h.file}::${h.method}:${h.routePath}`;
}

function projectRelative(absOrRel: string): string {
  // Tests run from project root; ROUTE_FILES are project-relative.
  return path.isAbsolute(absOrRel)
    ? path.relative(process.cwd(), absOrRel)
    : absOrRel;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("T-10 C-200/C-201/C-202: route contract guard", () => {
  it("T-10 C-200: every non-exempt explorer-route handler invokes buildSecurityFilter + readBranchHeader + routeMetric", () => {
    const violations: string[] = [];
    for (const file of ROUTE_FILES) {
      const handlers = collectHandlers(file);
      // Sanity: every guarded file should expose at least one handler.
      expect(
        handlers.length,
        `${file} should declare at least one router handler`,
      ).toBeGreaterThan(0);
      for (const h of handlers) {
        const key = keyFor({ ...h, file: projectRelative(h.file) });
        if (EXEMPT_LIST.includes(key)) continue;
        if (!/buildSecurityFilter\s*\(/.test(h.bodyText)) {
          violations.push(`${key}: missing buildSecurityFilter(...) call`);
        }
        if (!/readBranchHeader\s*\(/.test(h.bodyText)) {
          violations.push(`${key}: missing readBranchHeader(...) call`);
        }
        if (!/routeMetric\s*\(/.test(h.bodyText)) {
          violations.push(`${key}: missing routeMetric(...) call`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("T-10 C-201: every EXEMPT_LIST entry has a justification in EXEMPT_REASONS", () => {
    const orphans = EXEMPT_LIST.filter((k) => !(k in EXEMPT_REASONS));
    expect(orphans, `Exempt entries missing reason: ${orphans.join(", ")}`).toEqual([]);
  });

  it("T-10 C-201b: every exempt key actually identifies a real handler", () => {
    const allKeys = new Set<string>();
    for (const file of ROUTE_FILES) {
      for (const h of collectHandlers(file)) {
        allKeys.add(keyFor({ ...h, file: projectRelative(h.file) }));
      }
    }
    const stale = EXEMPT_LIST.filter((k) => !allKeys.has(k));
    expect(
      stale,
      `EXEMPT_LIST contains entries that do not match any handler: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("T-10 C-202: every routeMetric literal in the routes is a member of the RouteName union", () => {
    const knownRoutes = readRouteNameUnion();
    const observed = new Set<string>();
    const literalRe = /routeMetric\s*\(\s*\w+\s*,\s*["']([^"']+)["']/g;
    for (const file of ROUTE_FILES) {
      const text = fs.readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = literalRe.exec(text)) !== null) {
        observed.add(m[1]);
      }
    }
    const orphans = [...observed].filter((r) => !knownRoutes.has(r));
    expect(
      orphans,
      `routeMetric literals not in RouteName union: ${orphans.join(", ")}`,
    ).toEqual([]);
    // And the union should not have unused entries — every name MUST
    // appear at a call site (closed-form invariant).
    const unused = [...knownRoutes].filter((r) => !observed.has(r));
    expect(
      unused,
      `RouteName union has unused entries: ${unused.join(", ")}`,
    ).toEqual([]);
  });
});

function readRouteNameUnion(): Set<string> {
  const text = fs.readFileSync(
    "src/utils/routeInstrumentation.ts",
    "utf8",
  );
  const out = new Set<string>();
  // Capture the `export type RouteName = | "..." | "..." | ...;` block.
  const start = text.indexOf("export type RouteName");
  const end = text.indexOf(";", start);
  const block = text.slice(start, end);
  const re = /["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.add(m[1]);
  }
  return out;
}
