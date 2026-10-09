// Funnel fleet invariant report — compiled into the image as
// dist/funnelInvariants.js so ./run.sh can run it inside the deployed `app`
// container after every deploy (same network, credentials and object store
// as production). Read-only: SELECTs plus optional S3 HEAD / ≤64 KiB reads.
// Checks: src/services/funnel/funnelInvariants.ts.
//
//   node dist/funnelInvariants.js [--prefix <apiNamePrefix>] [--ontology <uuid>]
//        [--probe-storage] [--fail-on warn|error]
//
// stdout: the JSON report only. stderr: a one-line summary per code.
// Exit 0 clean, 1 violations at/above --fail-on (default error), 2 checker failure.
import { checkFunnelInvariants, createStorageSourceProbe } from "./services/funnel/funnelInvariants";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  // Keep stdout pure JSON: route library chatter (pool logs) to stderr.
  const writeOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  const db = await import("./db");
  try {
    const report = await checkFunnelInvariants(db, {
      objectTypeApiNamePrefix: arg("prefix"),
      ontologyId: arg("ontology"),
      sourceProbe: process.argv.includes("--probe-storage") ? await createStorageSourceProbe() : undefined,
    });
    writeOut(`${JSON.stringify(report, null, 2)}\n`);
    console.error(
      `[funnel-invariants] types=${report.objectTypesChecked} errors=${report.errors} ` +
        `warnings=${report.warnings} storageProbed=${report.sourceProbed}`,
    );
    for (const [code, n] of Object.entries(report.counts)) {
      const names = report.violations
        .filter((v) => v.code === code)
        .slice(0, 5)
        .map((v) => v.objectTypeApiName);
      console.error(`[funnel-invariants]   ${code}=${n} e.g. ${names.join(", ")}`);
    }
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
