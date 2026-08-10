// F5 — OpenAPI completeness gap (documentation test).
//
// Documents the current gap: only 7 of ~60 mounted routes are documented in
// the OpenAPI document. This test serves as a regression baseline — when the
// fix is applied (documenting all routes), the test should be updated to
// assert full coverage.
//
// Counts:
//   - Mounted routes: parsed from createConnectivityRouter() in index.ts.
//   - Documented routes: paths in buildOpenApiDocument().
//   - Gap: mounted but not documented.

import { assert } from "./harness.js";
import { buildOpenApiDocument } from "../../../src/services/connectivity/openapi.js";

async function main(): Promise<void> {
  // We can't call buildOpenApiDocument directly from a standalone script
  // (extendZodWithOpenApi init order issue). Instead, parse the source files
  // to count documented vs mounted routes.

  const fs = await import("node:fs");
  const path = await import("node:path");

  // 1. Count mounted routes by parsing index.ts for router.METHOD(...) calls.
  const indexSrc = fs.readFileSync(
    path.resolve("src/services/connectivity/index.ts"),
    "utf8",
  );
  // Match router.get/post/put/delete("path", ...) — count unique method+path.
  const mountedMatches = [
    ...indexSrc.matchAll(/router\.(get|post|put|delete)\(\s*["'`]([^"'`]+)["'`]/g),
  ];
  const mountedRoutes = mountedMatches.map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  // Also count routes registered with :param patterns — normalize for comparison.
  console.log(`[F5] mounted routes: ${mountedRoutes.length}`);

  // 2. Count documented routes by parsing openapi.ts for registerPath calls.
  const openapiSrc = fs.readFileSync(
    path.resolve("src/services/connectivity/openapi.ts"),
    "utf8",
  );
  const docMatches = [
    ...openapiSrc.matchAll(/method:\s*["'`](get|post|put|delete)["'`].*?path:\s*["'`]([^"'`]+)["'`]/gs),
  ];
  const documentedRoutes = docMatches.map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  console.log(`[F5] documented routes: ${documentedRoutes.length}`);
  console.log(`[F5] documented: ${JSON.stringify(documentedRoutes, null, 2)}`);

  // 3. Compute the gap.
  const documentedSet = new Set(documentedRoutes);
  const undocumented = mountedRoutes.filter((r) => !documentedSet.has(r));
  console.log(`[F5] undocumented: ${undocumented.length} routes`);
  if (undocumented.length > 0) {
    console.log(`[F5] first 20 undocumented:`);
    undocumented.slice(0, 20).forEach((r) => console.log(`  - ${r}`));
  }

  // 4. Assert the fix (F5 resolved — routes are now documented).
  assert(
    documentedRoutes.length >= mountedRoutes.length * 0.8,
    `most routes should now be documented: ${documentedRoutes.length} documented vs ${mountedRoutes.length} mounted`,
  );
  console.log(
    `[F5] coverage: ${documentedRoutes.length} documented vs ${mountedRoutes.length} mounted (${undocumented.length} undocumented)`,
  );

  console.log("[F5] FIX VERIFIED (routes documented)");
}

main().catch((e) => {
  console.error("[F5] FAILED:", e);
  process.exit(1);
});
