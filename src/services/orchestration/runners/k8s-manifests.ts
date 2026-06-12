// ---------------------------------------------------------------------------
// B4 — Kubernetes Job manifests for the gVisor-sandboxed foundry worker.
//
// FOUNDRY-GAPS §1: "Safe execution of user-authored code" — the worker that
// runs import strategies (the real user-code surface) is dispatched as a
// Kubernetes Job pinned to a `runtimeClassName: gvisor` (runsc) RuntimeClass,
// so each job runs inside a gVisor-isolated kernel rather than sharing the
// host kernel. The substrate is proven in deploy/substrate/verify-substrate.sh
// (§3); this is the wiring that schedules the workload onto it.
//
// These builders are PURE (no I/O, no k8s client) so the full manifest shape —
// the gVisor pinning, the hardened securityContext, the egress NetworkPolicy —
// is unit-testable without a cluster. k8s-runtime.ts applies them via the
// client.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { JobSpec } from "./runtime-adapter";

export interface K8sRuntimeOptions {
  /** Namespace the worker Jobs run in. */
  namespace: string;
  /** Worker container image (must contain the foundry-worker entrypoint). */
  image: string;
  /**
   * RuntimeClass name — the gVisor sandbox. This is the security control: a
   * Job with this set is scheduled by containerd onto the `runsc` handler.
   */
  runtimeClassName: string;
  /** Unprivileged uid/gid the container runs as (matches the worker default). */
  workerUid: number;
  workerGid: number;
  /** Resource requests/limits (Kubernetes quantity strings). */
  cpuRequest: string;
  cpuLimit: string;
  memRequest: string;
  memLimit: string;
  /** Reap finished Jobs after this many seconds. */
  ttlSecondsAfterFinished: number;
  /** Writable scratch volume size (the rootfs is read-only). */
  scratchSizeLimit: string;
  /** Optional ServiceAccount; omit to use the namespace default. */
  serviceAccount?: string;
  /** Env vars copied into the container (e.g. TELLUS_INTERNAL_URL, NODE_ENV). */
  passthroughEnv?: Record<string, string>;
}

const DNS1123_MAX = 63;

/**
 * Deterministic, DNS-1123-safe Job name for a build RID. RIDs carry dots and
 * colons; we slugify and append a short content hash so two RIDs that slugify
 * to the same prefix never collide, and the result always ends alphanumeric.
 */
export function jobName(buildRid: string): string {
  const hash = createHash("sha1").update(buildRid).digest("hex").slice(0, 8);
  const slug = buildRid
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const suffix = `-${hash}`;
  const prefix = `tellus-build-${slug}`
    .slice(0, DNS1123_MAX - suffix.length)
    .replace(/-+$/g, "");
  return `${prefix}${suffix}`;
}

/** Labels stamped on the Job, the Pod template, and the NetworkPolicy match. */
export function jobLabels(spec: JobSpec): Record<string, string> {
  return {
    "app.kubernetes.io/name": "tellus-foundry-worker",
    "app.kubernetes.io/managed-by": "tellus-orchestration",
    "tellus.io/build-rid": labelSafe(spec.buildRid),
    "tellus.io/tenant": labelSafe(spec.tenant),
    "tellus.io/kind": labelSafe(spec.kind),
  };
}

function labelSafe(v: string): string {
  // Label values: ≤63 chars, [a-z0-9A-Z] at the ends, [-_.] allowed inside.
  const s = v
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, DNS1123_MAX);
  return s.replace(/[^a-zA-Z0-9]+$/, "") || "unknown";
}

/**
 * Build the V1Job manifest for a worker job. The pod:
 *   - runs under the gVisor RuntimeClass (kernel isolation);
 *   - is non-root, no privilege escalation, read-only rootfs, all caps dropped,
 *     seccomp RuntimeDefault (defence-in-depth alongside gVisor);
 *   - never mounts a ServiceAccount token (the worker authenticates with its
 *     short-lived workload JWT, not the pod SA);
 *   - is killed by the kubelet at `activeDeadlineSeconds` (the soft deadline);
 *   - carries the JobSpec + workload JWT via env, exactly like the
 *     child_process sandbox, so the entrypoint is byte-for-byte unchanged.
 */
export function buildJobManifest(
  spec: JobSpec,
  opts: K8sRuntimeOptions,
): Record<string, unknown> {
  const name = jobName(spec.buildRid);
  const labels = jobLabels(spec);
  const deadlineSeconds = Math.max(1, Math.ceil(spec.deadlineMs / 1000));

  const env: Array<{ name: string; value: string }> = [
    { name: "TELLUS_JOB_SPEC", value: JSON.stringify(spec) },
    { name: "TELLUS_WORKLOAD_JWT", value: spec.workloadJwt },
    { name: "TELLUS_JOB_TMPDIR", value: "/tmp/job" },
    { name: "TELLUS_WORKER_UID", value: String(opts.workerUid) },
    { name: "TELLUS_WORKER_GID", value: String(opts.workerGid) },
  ];
  for (const [k, v] of Object.entries(opts.passthroughEnv ?? {})) {
    env.push({ name: k, value: v });
  }

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name, namespace: opts.namespace, labels },
    spec: {
      // Orchestration owns retries (it re-submits with a new build RID); the
      // Job itself must not silently re-run user code.
      backoffLimit: 0,
      activeDeadlineSeconds: deadlineSeconds,
      ttlSecondsAfterFinished: opts.ttlSecondsAfterFinished,
      template: {
        metadata: { labels },
        spec: {
          runtimeClassName: opts.runtimeClassName,
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          ...(opts.serviceAccount
            ? { serviceAccountName: opts.serviceAccount }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: opts.workerUid,
            runAsGroup: opts.workerGid,
            fsGroup: opts.workerGid,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "worker",
              image: opts.image,
              env,
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
            {
              name: "scratch",
              emptyDir: { sizeLimit: opts.scratchSizeLimit },
            },
          ],
        },
      },
    },
  };
}

/**
 * Build a default-deny-egress NetworkPolicy scoped to this job's pod, opening
 * only DNS plus the destinations in the JobSpec egress policy. This is the
 * outer (Cilium-enforced) layer; the worker entrypoint additionally enforces
 * the precise host:port allowlist in-process (egress-allowlist.ts). CIDRs map
 * to ipBlock rules; bare host:port entries (NetworkPolicy can't match DNS
 * names) open the port and rely on the in-process check for the host match.
 */
export function buildEgressNetworkPolicy(
  spec: JobSpec,
  opts: K8sRuntimeOptions,
): Record<string, unknown> {
  const name = `${jobName(spec.buildRid)}-egress`;
  const ports = uniquePorts(spec.egress.allow.map((a) => a.port));

  const egress: Array<Record<string, unknown>> = [
    // DNS resolution to the cluster resolver (kube-dns / CoreDNS).
    {
      ports: [
        { protocol: "UDP", port: 53 },
        { protocol: "TCP", port: 53 },
      ],
    },
  ];

  if (spec.egress.cidrs.length > 0) {
    egress.push({
      to: spec.egress.cidrs.map((cidr) => ({ ipBlock: { cidr } })),
      ...(ports.length > 0
        ? { ports: ports.map((p) => ({ protocol: "TCP", port: p })) }
        : {}),
    });
  } else if (ports.length > 0) {
    // No CIDR scoping available — open the allowed ports to any destination;
    // the in-process allowlist pins the exact host.
    egress.push({ ports: ports.map((p) => ({ protocol: "TCP", port: p })) });
  }

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name, namespace: opts.namespace, labels: jobLabels(spec) },
    spec: {
      podSelector: {
        matchLabels: { "tellus.io/build-rid": labelSafe(spec.buildRid) },
      },
      policyTypes: ["Egress"],
      egress,
    },
  };
}

function uniquePorts(ports: number[]): number[] {
  return [...new Set(ports.filter((p) => Number.isInteger(p) && p > 0))].sort(
    (a, b) => a - b,
  );
}

/**
 * Classify a Kubernetes Job `.status` into the runtime's terminal outcome, or
 * null while the job is still running. Pure so the lifecycle mapping is
 * testable without a cluster.
 */
export function classifyJobStatus(status: {
  succeeded?: number;
  failed?: number;
  conditions?: Array<{ type?: string; status?: string; reason?: string }>;
}): { kind: "succeeded" | "failed" | "timeout"; reason?: string } | null {
  const conditions = status.conditions ?? [];
  const failed = conditions.find(
    (c) => c.type === "Failed" && c.status === "True",
  );
  if (failed) {
    // The kubelet sets reason=DeadlineExceeded when activeDeadlineSeconds trips.
    return failed.reason === "DeadlineExceeded"
      ? { kind: "timeout", reason: failed.reason }
      : { kind: "failed", reason: failed.reason };
  }
  const complete = conditions.find(
    (c) => c.type === "Complete" && c.status === "True",
  );
  if (complete || (status.succeeded ?? 0) > 0) return { kind: "succeeded" };
  if ((status.failed ?? 0) > 0) return { kind: "failed", reason: "PodFailed" };
  return null;
}

/** Resolve runtime options from the environment (called once at boot). */
export function k8sRuntimeOptionsFromEnv(): K8sRuntimeOptions {
  return {
    namespace: process.env.TELLUS_WORKER_NAMESPACE ?? "tellus-workers",
    image:
      process.env.TELLUS_WORKER_IMAGE ?? "ghcr.io/tellus/foundry-worker:latest",
    runtimeClassName: process.env.TELLUS_WORKER_RUNTIME_CLASS ?? "gvisor",
    workerUid: Number(process.env.TELLUS_WORKER_UID ?? "65534"),
    workerGid: Number(process.env.TELLUS_WORKER_GID ?? "65534"),
    cpuRequest: process.env.TELLUS_WORKER_CPU_REQUEST ?? "250m",
    cpuLimit: process.env.TELLUS_WORKER_CPU_LIMIT ?? "2",
    memRequest: process.env.TELLUS_WORKER_MEM_REQUEST ?? "512Mi",
    memLimit:
      process.env.TELLUS_WORKER_MEM_LIMIT ??
      `${process.env.TELLUS_WORKER_MAX_OLD_SPACE_MB ?? 2048}Mi`,
    ttlSecondsAfterFinished: Number(
      process.env.TELLUS_WORKER_TTL_SECONDS ?? "3600",
    ),
    scratchSizeLimit: process.env.TELLUS_WORKER_SCRATCH_LIMIT ?? "2Gi",
    serviceAccount: process.env.TELLUS_WORKER_SERVICE_ACCOUNT,
    passthroughEnv: collectPassthroughEnv(),
  };
}

const PASSTHROUGH_ENV = [
  "NODE_ENV",
  "TELLUS_ICEBERG_ROOT",
  "TELLUS_KMS_ADAPTER",
  "TELLUS_LOG_LEVEL",
  "TELLUS_OTEL_ENDPOINT",
  "TELLUS_INTERNAL_URL",
  "TZ",
  "LANG",
];

function collectPassthroughEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
