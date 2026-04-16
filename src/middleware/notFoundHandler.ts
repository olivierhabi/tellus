// ---------------------------------------------------------------------------
// 404 Not Found Handler & API Documentation Endpoint (Task 20)
//
// Middleware for unmatched routes that returns a helpful error response
// with a reference to the API documentation endpoint.
//
// Also provides GET /api/docs to list all registered routes.
//
// Run self-tests: npx tsx src/middleware/notFoundHandler.ts
// ---------------------------------------------------------------------------

import { Router, Request, Response, Express } from "express";

// ---------------------------------------------------------------------------
// 404 Handler Middleware
// ---------------------------------------------------------------------------

/**
 * Middleware for unmatched routes. Must be registered after ALL route
 * handlers and before the error handler.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: `${req.method} ${req.path} is not a valid API endpoint`,
      availableEndpoints: "/api/docs",
      timestamp: new Date().toISOString(),
    },
  });
}

// ---------------------------------------------------------------------------
// Route extraction utility
// ---------------------------------------------------------------------------

interface RouteInfo {
  method: string;
  path: string;
}

/**
 * Extract all registered routes from an Express application.
 * Walks the middleware stack and collects route definitions.
 */
export function extractRoutes(app: Express): RouteInfo[] {
  const routes: RouteInfo[] = [];

  function processStack(stack: any[], prefix: string = ""): void {
    if (!Array.isArray(stack)) return;

    for (const layer of stack) {
      if (layer.route) {
        // Direct route
        const routePath = prefix + (layer.route.path || "");
        for (const method of Object.keys(layer.route.methods)) {
          routes.push({
            method: method.toUpperCase(),
            path: routePath || "/",
          });
        }
      } else if (layer.name === "router" && layer.handle?.stack) {
        // Sub-router
        const routerPath = layer.regexp
          ? extractPathFromRegexp(layer.regexp, layer.keys || [])
          : "";
        processStack(layer.handle.stack, prefix + routerPath);
      }
    }
  }

  if (app._router?.stack) {
    processStack(app._router.stack);
  }

  // Sort routes by path then method
  routes.sort((a, b) => {
    const pathCompare = a.path.localeCompare(b.path);
    if (pathCompare !== 0) return pathCompare;
    return a.method.localeCompare(b.method);
  });

  return routes;
}

/**
 * Best-effort extraction of path string from Express route regexp.
 * Express internally compiles path strings to regexps, and we need
 * to reverse this for display purposes.
 */
function extractPathFromRegexp(regexp: RegExp, keys: Array<{ name: string }>): string {
  let path = regexp.source;

  // Remove common Express regexp wrappers
  path = path.replace(/^\^\\\//, "/");
  path = path.replace(/\\\/\?\(\?=\\\/\|\$\)$/, "");
  path = path.replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/, "");
  path = path.replace(/\\\//g, "/");

  // If we have named parameters, try to reconstruct them
  if (keys.length > 0) {
    let keyIndex = 0;
    path = path.replace(/\(\?:\(\[\^\/\]\+\?\)\)/g, () => {
      const key = keys[keyIndex++];
      return key ? `:${key.name}` : ":param";
    });
  }

  // Clean up remaining regexp artifacts
  path = path.replace(/\(\?:([^)]+)\)/g, "$1");
  path = path.replace(/\[\^[^\]]*\]/g, "");
  path = path.replace(/[?+*{}()\\^$|]/g, "");

  // Ensure it starts with /
  if (!path.startsWith("/")) {
    path = "/" + path;
  }

  // Remove trailing slashes (except root)
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  return path;
}

// ---------------------------------------------------------------------------
// Router: API Documentation Endpoint
// ---------------------------------------------------------------------------

/**
 * Create a router that provides the /api/docs endpoint listing.
 * The app reference is needed to extract registered routes.
 */
export function createDocsRouter(app: Express): Router {
  const router = Router();

  router.get("/api/docs", (_req: Request, res: Response) => {
    const routes = extractRoutes(app);

    // Group by path prefix
    const grouped: Record<string, RouteInfo[]> = {};
    for (const route of routes) {
      // Extract group from path (e.g., "/api/v1/ontology" -> "ontologies")
      const parts = route.path.split("/").filter(Boolean);
      const group = parts[2] || parts[1] || "root";
      if (!grouped[group]) grouped[group] = [];
      grouped[group].push(route);
    }

    res.json({
      totalRoutes: routes.length,
      endpoints: routes,
      groups: grouped,
      documentation: "/api/docs",
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

export default notFoundHandler;

// ---------------------------------------------------------------------------
// Inline self-tests (run: npx tsx src/middleware/notFoundHandler.ts)
// ---------------------------------------------------------------------------

export function runSelfTests(): void {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, label: string): void {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.error(`  FAIL: ${label}`);
      /* v8 ignore next 2 */
      failed++;
    }
  }

  console.log("Running notFoundHandler self-tests...\n");

  // =========================================================================
  // 1. notFoundHandler returns 404 with correct shape
  // =========================================================================
  console.log("=== 1. notFoundHandler response ===");
  {
    let statusCode = 0;
    let responseBody: any = null;

    const mockReq = {
      method: "GET",
      path: "/api/v1/nonexistent",
    } as Request;

    const mockRes = {
      status: (code: number) => { statusCode = code; return mockRes; },
      json: (body: any) => { responseBody = body; return mockRes; },
    } as unknown as Response;

    notFoundHandler(mockReq, mockRes);

    assert(statusCode === 404, "status is 404");
    assert(responseBody.error.code === "ROUTE_NOT_FOUND", "error code is ROUTE_NOT_FOUND");
    assert(
      responseBody.error.message === "GET /api/v1/nonexistent is not a valid API endpoint",
      "error message includes method and path"
    );
    assert(
      responseBody.error.availableEndpoints === "/api/docs",
      "includes availableEndpoints reference"
    );
    assert(typeof responseBody.error.timestamp === "string", "has timestamp");
  }

  // =========================================================================
  // 2. notFoundHandler for POST method
  // =========================================================================
  console.log("\n=== 2. POST method ===");
  {
    let responseBody: any = null;

    const mockReq = {
      method: "POST",
      path: "/api/v1/unknown",
    } as Request;

    const mockRes = {
      status: () => mockRes,
      json: (body: any) => { responseBody = body; return mockRes; },
    } as unknown as Response;

    notFoundHandler(mockReq, mockRes);

    assert(
      responseBody.error.message.startsWith("POST"),
      "message starts with POST"
    );
  }

  // =========================================================================
  // 3. notFoundHandler for DELETE method
  // =========================================================================
  console.log("\n=== 3. DELETE method ===");
  {
    let responseBody: any = null;

    const mockReq = {
      method: "DELETE",
      path: "/api/v1/things/123",
    } as Request;

    const mockRes = {
      status: () => mockRes,
      json: (body: any) => { responseBody = body; return mockRes; },
    } as unknown as Response;

    notFoundHandler(mockReq, mockRes);

    assert(
      responseBody.error.message === "DELETE /api/v1/things/123 is not a valid API endpoint",
      "DELETE message correct"
    );
  }

  // =========================================================================
  // 4. extractPathFromRegexp helper
  // =========================================================================
  console.log("\n=== 4. extractPathFromRegexp ===");
  {
    // Simple path
    const simple = extractPathFromRegexp(/^\/api\/v1\/health\/?(?=\/|$)/i, []);
    assert(simple.includes("api") && simple.includes("health"), "extracts simple path components");

    // With params
    const withParams = extractPathFromRegexp(
      /^\/api\/v1\/ontology\/(?:([^\/]+?))\/?(?=\/|$)/i,
      [{ name: "ontologyId" } as any]
    );
    assert(withParams.includes("ontology"), "extracts parameterized path");
  }

  // =========================================================================
  // 5. extractRoutes handles empty app
  // =========================================================================
  console.log("\n=== 5. extractRoutes edge cases ===");
  {
    // Mock app with no router
    const emptyApp = {} as Express;
    const routes = extractRoutes(emptyApp);
    assert(routes.length === 0, "empty app returns no routes");

    // Mock app with empty router
    const appWithRouter = { _router: { stack: [] } } as unknown as Express;
    const routes2 = extractRoutes(appWithRouter);
    assert(routes2.length === 0, "empty router returns no routes");
  }

  // =========================================================================
  // 6. Error response shape validation
  // =========================================================================
  console.log("\n=== 6. Response shape ===");
  {
    let responseBody: any = null;

    const mockReq = { method: "PUT", path: "/test" } as Request;
    const mockRes = {
      status: () => mockRes,
      json: (body: any) => { responseBody = body; return mockRes; },
    } as unknown as Response;

    notFoundHandler(mockReq, mockRes);

    assert("error" in responseBody, "has error key");
    assert("code" in responseBody.error, "error has code");
    assert("message" in responseBody.error, "error has message");
    assert("availableEndpoints" in responseBody.error, "error has availableEndpoints");
    assert("timestamp" in responseBody.error, "error has timestamp");
  }

  // =========================================================================
  // 7. Timestamp is valid ISO 8601
  // =========================================================================
  console.log("\n=== 7. Timestamp format ===");
  {
    let responseBody: any = null;

    const mockReq = { method: "GET", path: "/test" } as Request;
    const mockRes = {
      status: () => mockRes,
      json: (body: any) => { responseBody = body; return mockRes; },
    } as unknown as Response;

    notFoundHandler(mockReq, mockRes);

    const ts = responseBody.error.timestamp;
    const parsed = new Date(ts);
    assert(!isNaN(parsed.getTime()), "timestamp is valid date");
    assert(ts.endsWith("Z"), "timestamp ends with Z");
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("\nAll notFoundHandler tests passed");
  } else {
    /* v8 ignore next */
    process.exit(1);
  }
}

/* v8 ignore start */
if (require.main === module) {
  runSelfTests();
}
/* v8 ignore stop */
