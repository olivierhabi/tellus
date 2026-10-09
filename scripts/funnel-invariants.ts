#!/usr/bin/env tsx
// Read-only funnel fleet invariant report (src/services/funnel/funnelInvariants.ts).
//
//   pnpm exec tsx scripts/funnel-invariants.ts [--prefix <apiNamePrefix>]
//        [--ontology <uuid>] [--probe-storage] [--fail-on warn|error]
//
// Prints the JSON report on stdout. Exit 1 when violations at/above
// --fail-on (default: error) exist, 2 on checker failure. Safe against a
// production database: SELECT-only plus optional S3 HEAD/bounded GET.
import { checkFunnelInvariants, createStorageSourceProbe } from "../src/services/funnel/funnelInvariants";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  // Keep stdout pure JSON: route library chatter (pool logs) to stderr.
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  const db = await import("../src/db");
  try {
    const report = await checkFunnelInvariants(db, {
      objectTypeApiNamePrefix: arg("prefix"),
      ontologyId: arg("ontology"),
      sourceProbe: process.argv.includes("--probe-storage") ? await createStorageSourceProbe() : undefined,
    });
    writeOut(`${JSON.stringify(report, null, 2)}\n`);
    const failOn = arg("fail-on") === "warn" ? "warn" : "error";
    const failing = failOn === "warn" ? report.errors + report.warnings : report.errors;
    return failing > 0 ? 1 : 0;
  } finally {
    await db.pool.end().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
