// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §2 — UDF transforms (user-authored code), executed in gVisor.
//
// A UDF is the one transform that CANNOT compile to engine SQL: it is
// arbitrary user code (Python or JS), so it must run inside the user-code
// sandbox that §1/§3 proved on real Kubernetes — a Kubernetes Job pinned to
// the `gvisor` (runsc) RuntimeClass with a hardened pod and a default-deny
// NetworkPolicy. This is Foundry's "Python transform" analog.
//
// This module is PURE (types, validation, manifest builders, result parsing)
// so the full sandbox shape is unit-testable without a cluster, exactly like
// k8s-manifests.ts. The lazy k8s client + lifecycle glue lives in
// udfRunner.ts; the authoring surface (persist a UDF onto a node) lives in
// TransformService.
//
// Isolation note: a row-transform UDF needs ZERO network, so unlike the
// import worker its egress policy denies everything (no DNS) — the strongest
// posture the substrate allows, layered on top of the gVisor kernel.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { AppError } from "../../utils/foundryAppError";

export const UDF_LANGUAGES = ["python", "javascript"] as const;
export type UdfLanguage = (typeof UDF_LANGUAGES)[number];

/** A UDF transform step. Stored on a node's `config.udfTransform` slot — kept
 *  out of `config.transforms` so the SQL compilers never try to fold it. */
export interface UdfTransformSpec {
  function: "Udf";
  language: UdfLanguage;
  /** User-authored source. Must define `entrypoint` taking one row → one row. */
  code: string;
  /** Name of the function to call per row. Default "transform". */
  entrypoint: string;
  /** The columns the UDF promises to emit (downstream typing + schema check). */
  outputColumns: Array<{ name: string; type: string }>;
  /** Hard wall-clock cap; the Job's activeDeadlineSeconds is derived from it. */
  timeoutMs: number;
}

const MAX_CODE_BYTES = 256 * 1024; // 256 KiB of source — generous, bounded.
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000; // 15 min hard ceiling.
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Validate + normalize a raw UDF spec from the authoring surface. Throws a
 * typed 422 on anything malformed so the API returns a clean envelope rather
 * than scheduling a doomed Job.
 */
export function validateUdfSpec(raw: unknown): UdfTransformSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const language = r.language;
  if (language !== "python" && language !== "javascript") {
    throw new AppError(
      `UDF language must be one of: ${UDF_LANGUAGES.join(", ")}`,
      422,
      "UDF_BAD_LANGUAGE",
    );
  }
  const code = typeof r.code === "string" ? r.code : "";
  if (code.trim().length === 0) {
    throw new AppError("UDF code is required", 422, "UDF_EMPTY_CODE");
  }
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    throw new AppError(
      `UDF code exceeds ${MAX_CODE_BYTES} bytes`,
      422,
      "UDF_CODE_TOO_LARGE",
    );
  }
  const entrypoint =
    typeof r.entrypoint === "string" && r.entrypoint.trim().length > 0
      ? r.entrypoint.trim()
      : "transform";
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entrypoint)) {
    throw new AppError(
      "UDF entrypoint must be a valid identifier",
      422,
      "UDF_BAD_ENTRYPOINT",
    );
  }
  const cols = Array.isArray(r.outputColumns) ? r.outputColumns : [];
  const outputColumns = cols.map((c) => {
    const cc = (c ?? {}) as Record<string, unknown>;
    if (typeof cc.name !== "string" || cc.name.trim().length === 0) {
      throw new AppError(
        "Each UDF output column needs a name",
        422,
        "UDF_BAD_OUTPUT_COLUMN",
      );
    }
    return {
      name: cc.name.trim(),
      type: typeof cc.type === "string" ? cc.type : "string",
    };
  });
  let timeoutMs =
    typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs)
      ? Math.floor(r.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutMs));

  return { function: "Udf", language, code, entrypoint, outputColumns, timeoutMs };
}

// ---------------------------------------------------------------------------
// In-pod harness. The user's `code` is injected, then the harness reads the
// rows from /tmp/job/udf-input.json (mounted via the spec env, written by the
// init wrapper below), maps the entrypoint over every row, and prints the
// result JSON between sentinels so the parent can recover it from pod logs.
//
// The harness is deliberately tiny and reads input from an env var rather than
// the network — the pod has no egress at all.
// ---------------------------------------------------------------------------

export const UDF_RESULT_BEGIN = "__TELLUS_UDF_RESULT_BEGIN__";
export const UDF_RESULT_END = "__TELLUS_UDF_RESULT_END__";

export function pythonHarness(userCode: string, entrypoint: string): string {
  // The user code is concatenated above the harness; the entrypoint name is
  // resolved from the resulting globals. Input arrives base64 in TELLUS_UDF_INPUT.
  return `import json, os, base64, sys
${userCode}
def __tellus_main():
    raw = base64.b64decode(os.environ["TELLUS_UDF_INPUT"]).decode("utf-8")
    rows = json.loads(raw)
    fn = globals().get(${JSON.stringify(entrypoint)})
    if not callable(fn):
        sys.stderr.write("UDF entrypoint ${entrypoint} is not callable\\n")
        sys.exit(7)
    out = [fn(r) for r in rows]
    sys.stdout.write(${JSON.stringify(UDF_RESULT_BEGIN)} + "\\n")
    sys.stdout.write(json.dumps(out) + "\\n")
    sys.stdout.write(${JSON.stringify(UDF_RESULT_END)} + "\\n")
__tellus_main()
`;
}

export function javascriptHarness(userCode: string, entrypoint: string): string {
  return `${userCode}
(function () {
  const raw = Buffer.from(process.env.TELLUS_UDF_INPUT, "base64").toString("utf-8");
  const rows = JSON.parse(raw);
  const fn = (typeof ${entrypoint} === "function") ? ${entrypoint} : (globalThis[${JSON.stringify(entrypoint)}]);
  if (typeof fn !== "function") {
    process.stderr.write("UDF entrypoint ${entrypoint} is not a function\\n");
    process.exit(7);
  }
  const out = rows.map((r) => fn(r));
  process.stdout.write(${JSON.stringify(UDF_RESULT_BEGIN)} + "\\n");
  process.stdout.write(JSON.stringify(out) + "\\n");
  process.stdout.write(${JSON.stringify(UDF_RESULT_END)} + "\\n");
})();
`;
}

export interface UdfRuntimeOptions {
  namespace: string;
  runtimeClassName: string;
  pythonImage: string;
  nodeImage: string;
  workerUid: number;
  workerGid: number;
  cpuRequest: string;
  cpuLimit: string;
  memRequest: string;
  memLimit: string;
  ttlSecondsAfterFinished: number;
  scratchSizeLimit: string;
  /** Pin the Job to a node (k3d single-node smoke tests). */
  nodeName?: string;
}

export function udfRuntimeOptionsFromEnv(): UdfRuntimeOptions {
  return {
    namespace: process.env.TELLUS_UDF_NAMESPACE ?? "tellus-udf",
    runtimeClassName: process.env.TELLUS_WORKER_RUNTIME_CLASS ?? "gvisor",
    pythonImage: process.env.TELLUS_UDF_PYTHON_IMAGE ?? "python:3.12-slim",
    nodeImage: process.env.TELLUS_UDF_NODE_IMAGE ?? "node:22-slim",
    workerUid: Number(process.env.TELLUS_WORKER_UID ?? "65534"),
    workerGid: Number(process.env.TELLUS_WORKER_GID ?? "65534"),
    cpuRequest: process.env.TELLUS_UDF_CPU_REQUEST ?? "100m",
    cpuLimit: process.env.TELLUS_UDF_CPU_LIMIT ?? "1",
    memRequest: process.env.TELLUS_UDF_MEM_REQUEST ?? "128Mi",
    memLimit: process.env.TELLUS_UDF_MEM_LIMIT ?? "512Mi",
    ttlSecondsAfterFinished: Number(process.env.TELLUS_UDF_TTL_SECONDS ?? "600"),
    scratchSizeLimit: process.env.TELLUS_UDF_SCRATCH_LIMIT ?? "256Mi",
    nodeName: process.env.TELLUS_UDF_NODE_NAME,
  };
}

const DNS1123_MAX = 63;

export function udfJobName(buildRid: string): string {
  const hash = createHash("sha1").update(buildRid).digest("hex").slice(0, 8);
  const slug = buildRid
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = `-${hash}`;
  const prefix = `tellus-udf-${slug}`
    .slice(0, DNS1123_MAX - suffix.length)
    .replace(/-+$/g, "");
  return `${prefix}${suffix}`;
}

export interface UdfJobInput {
  buildRid: string;
  tenant: string;
  spec: UdfTransformSpec;
  /** Bounded input rows. The engine path handles large data via SQL; UDFs run
   *  on bounded slices (preview, or post-pushdown projections). */
  rows: Array<Record<string, unknown>>;
}

/**
 * Build the gVisor-pinned, hardened, egress-denied Job that runs the UDF.
 * Pure — no I/O — so the sandbox shape is unit-tested without a cluster.
 *
 * Security posture (defence in depth on top of the gVisor kernel):
 *   - runtimeClassName: gvisor (runsc) — syscall-isolated kernel.
 *   - non-root uid 65534, readOnlyRootFilesystem, drop ALL caps,
 *     allowPrivilegeEscalation:false, seccomp RuntimeDefault.
 *   - automountServiceAccountToken:false — no cluster credentials in the pod.
 *   - backoffLimit:0 — never silently re-run user code.
 *   - activeDeadlineSeconds from the UDF timeout — bounded wall-clock.
 *   - paired with buildUdfDenyAllEgressPolicy: the pod has NO network at all.
 */
export function buildUdfJobManifest(
  input: UdfJobInput,
  opts: UdfRuntimeOptions,
): Record<string, unknown> {
  const name = udfJobName(input.buildRid);
  const labels = udfJobLabels(input);
  const deadlineSeconds = Math.max(
    1,
    Math.ceil(input.spec.timeoutMs / 1000),
  );
  const inputB64 = Buffer.from(JSON.stringify(input.rows), "utf8").toString(
    "base64",
  );

  const isPython = input.spec.language === "python";
  const program = isPython
    ? pythonHarness(input.spec.code, input.spec.entrypoint)
    : javascriptHarness(input.spec.code, input.spec.entrypoint);
  const image = isPython ? opts.pythonImage : opts.nodeImage;
  // The program is delivered through an env var and executed from stdin so we
  // never need a writable rootfs or a baked image.
  const interpreter = isPython
    ? ["python3", "-c", program]
    : ["node", "-e", program];

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: opts.namespace, labels },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: deadlineSeconds,
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished,
      template: {
        metadata: { labels },
        spec: {
          runtimeClassName: opts.runtimeClassName,
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          ...(opts.nodeName ? { nodeName: opts.nodeName } : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: opts.workerUid,
            runAsGroup: opts.workerGid,
            fsGroup: opts.workerGid,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "udf",
              image,
              command: interpreter,
              env: [{ name: "TELLUS_UDF_INPUT", value: inputB64 }],
              securityContext: {
                allowPrivilegeEscalation: false,
                privileged: false,
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: { cpu: opts.cpuRequest, memory: opts.memRequest },
                limits: { cpu: opts.cpuLimit, memory: opts.memLimit },
              },
              volumeMounts: [{ name: "scratch", mountPath: "/tmp" }],
            },
          ],
          volumes: [
            { name: "scratch", emptyDir: { sizeLimit: opts.scratchSizeLimit } },
          ],
        },
      },
    },
  };
}

/** A NetworkPolicy that denies ALL egress for the UDF pod — a row transform
 *  needs no network, so we give it none (not even DNS). */
export function buildUdfDenyAllEgressPolicy(
  input: UdfJobInput,
  opts: UdfRuntimeOptions,
): Record<string, unknown> {
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: `${udfJobName(input.buildRid)}-deny-egress`,
      namespace: opts.namespace,
      labels: udfJobLabels(input),
    },
    spec: {
      podSelector: {
        matchLabels: { "tellus.io/udf-rid": labelSafe(input.buildRid) },
      },
      policyTypes: ["Egress"],
      egress: [], // deny everything
    },
  };
}

export function udfJobLabels(input: UdfJobInput): Record<string, string> {
  return {
    "app.kubernetes.io/name": "tellus-udf",
    "app.kubernetes.io/managed-by": "tellus-pipelines",
    "tellus.io/udf-rid": labelSafe(input.buildRid),
    "tellus.io/tenant": labelSafe(input.tenant),
  };
}

function labelSafe(v: string): string {
  const s = v
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, DNS1123_MAX);
  return s.replace(/[^a-zA-Z0-9]+$/, "") || "unknown";
}

/**
 * Recover the UDF result from pod logs (the parent reads logs after the Job
 * completes). Returns the parsed output rows; throws a typed error if the
 * sentinels are missing (user code crashed or produced no result block).
 */
export function parseUdfResult(logs: string): Array<Record<string, unknown>> {
  const begin = logs.indexOf(UDF_RESULT_BEGIN);
  const end = logs.indexOf(UDF_RESULT_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new AppError(
      "UDF produced no result block (check the function returns a row per input)",
      422,
      "UDF_NO_RESULT",
    );
  }
  const json = logs.slice(begin + UDF_RESULT_BEGIN.length, end).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError("UDF result was not valid JSON", 422, "UDF_BAD_RESULT");
  }
  if (!Array.isArray(parsed)) {
    throw new AppError(
      "UDF result must be an array of rows",
      422,
      "UDF_BAD_RESULT",
    );
  }
  return parsed as Array<Record<string, unknown>>;
}
