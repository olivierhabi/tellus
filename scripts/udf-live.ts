// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §2 — LIVE proof: a user-authored UDF runs inside the gVisor
// sandbox and transforms real data.
//
// This renders the ACTUAL production manifest builders (buildUdfJobManifest +
// buildUdfDenyAllEgressPolicy from src/services/pipelines/udfTransform.ts),
// applies them to the live k3d cluster (gvisor RuntimeClass installed), waits
// for the Job, reads the pod logs, and parses the result with the production
// parseUdfResult. The UDF itself reads /proc/version inside transform() so the
// output proves the user code executed inside the gVisor kernel — not just
// that a pod was scheduled.
//
//   TELLUS_UDF_NODE_NAME=k3d-substrate-server-0 npx tsx scripts/udf-live.ts
// ---------------------------------------------------------------------------
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  buildUdfJobManifest,
  buildUdfDenyAllEgressPolicy,
  parseUdfResult,
  udfJobName,
  udfRuntimeOptionsFromEnv,
  validateUdfSpec,
  type UdfJobInput,
} from "../src/services/pipelines/udfTransform";

const NS = process.env.TELLUS_UDF_NAMESPACE ?? "tellus-udf";
const sh = (cmd: string) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const ok = (m: string) => console.log(`\x1b[32m✔ ${m}\x1b[0m`);
const die = (m: string) => { console.error(`\x1b[31m✘ ${m}\x1b[0m`); process.exit(1); };

// A genuine user UDF: reads the kernel banner (proves the sandbox) and computes
// a derived column over each row.
const spec = validateUdfSpec({
  language: "python",
  code: [
    "def transform(row):",
    "    with open('/proc/version') as f:",
    "        row['kernel'] = f.read().strip()",
    "    row['total'] = row['qty'] * row['price']",
    "    return row",
  ].join("\n"),
  entrypoint: "transform",
  outputColumns: [
    { name: "qty", type: "integer" },
    { name: "price", type: "numeric" },
    { name: "total", type: "numeric" },
    { name: "kernel", type: "string" },
  ],
  timeoutMs: 120000,
});

const input: UdfJobInput = {
  buildRid: "udf-live-proof-1",
  tenant: "acme",
  spec,
  rows: [
    { qty: 2, price: 3 },
    { qty: 5, price: 4 },
    { qty: 10, price: 1.5 },
  ],
};

const opts = udfRuntimeOptionsFromEnv();
const name = udfJobName(input.buildRid);
const job = buildUdfJobManifest(input, opts);
const netpol = buildUdfDenyAllEgressPolicy(input, opts);

async function main() {
  sh(`kubectl create namespace ${NS} --dry-run=client -o yaml | kubectl apply -f -`);
  sh(`kubectl delete job ${name} -n ${NS} --ignore-not-found >/dev/null 2>&1 || true`);

  writeFileSync("/tmp/udf-netpol.json", JSON.stringify(netpol));
  writeFileSync("/tmp/udf-job.json", JSON.stringify(job));
  sh(`kubectl apply -n ${NS} -f /tmp/udf-netpol.json`);
  ok("deny-all egress NetworkPolicy applied (UDF pod gets NO network)");
  sh(`kubectl apply -n ${NS} -f /tmp/udf-job.json`);
  ok(`UDF Job applied (runtimeClass=${opts.runtimeClassName}, image=${opts.pythonImage})`);

  // Wait for terminal state.
  let done = false;
  for (let i = 0; i < 90; i++) {
    const succ = sh(`kubectl get job ${name} -n ${NS} -o jsonpath='{.status.succeeded}' 2>/dev/null || true`).trim();
    const fail = sh(`kubectl get job ${name} -n ${NS} -o jsonpath='{.status.failed}' 2>/dev/null || true`).trim();
    if (succ === "1") { done = true; break; }
    if (fail && Number(fail) > 0) {
      const podsF = sh(`kubectl get pods -n ${NS} -l job-name=${name} -o name 2>/dev/null || true`).trim();
      const logsF = podsF ? sh(`kubectl logs -n ${NS} ${podsF.split("\n")[0]} 2>/dev/null || true`) : "";
      die(`UDF Job failed. logs:\n${logsF}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!done) die("UDF Job did not complete in time");
  ok("UDF Job completed");

  // Confirm gVisor admission: the pod must carry runtimeClassName gvisor.
  const rc = sh(`kubectl get pods -n ${NS} -l job-name=${name} -o jsonpath='{.items[0].spec.runtimeClassName}'`).trim();
  rc === opts.runtimeClassName ? ok(`pod scheduled with runtimeClassName=${rc}`) : die(`expected gvisor runtimeClass, got '${rc}'`);

  const pod = sh(`kubectl get pods -n ${NS} -l job-name=${name} -o name`).trim().split("\n")[0];
  const logs = sh(`kubectl logs -n ${NS} ${pod}`);
  const out = parseUdfResult(logs);

  // Assertions on the transformed output.
  if (out.length !== 3) die(`expected 3 rows, got ${out.length}`);
  const totals = out.map((r) => r.total);
  JSON.stringify(totals) === JSON.stringify([6, 20, 15]) ? ok(`derived column correct: totals=${JSON.stringify(totals)}`) : die(`totals wrong: ${JSON.stringify(totals)}`);
  const kernel = String(out[0].kernel ?? "");
  console.log(`  UDF observed kernel: ${kernel}`);
  /gvisor/i.test(kernel) ? ok("user code executed INSIDE the gVisor kernel (read /proc/version)") : die(`kernel is not gVisor: ${kernel}`);

  sh(`kubectl delete job ${name} -n ${NS} --ignore-not-found >/dev/null 2>&1 || true`);
  sh(`kubectl delete networkpolicy ${name}-deny-egress -n ${NS} --ignore-not-found >/dev/null 2>&1 || true`);
  console.log("\n\x1b[1;32m✔ §2 UDF LIVE PROOF PASSED — user code ran sandboxed in gVisor and transformed data\x1b[0m");
}

main().catch((e) => die(String(e?.stack ?? e)));
