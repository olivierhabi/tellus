// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §2 — UDF runner: submit a UDF Job onto the gVisor sandbox and
// recover its output from pod logs.
//
// Lazy-loads @kubernetes/client-node (same pattern as k8s-runtime.ts) so the
// pure builders in udfTransform.ts stay importable without the dependency. The
// runner applies the deny-all egress NetworkPolicy, creates the Job, waits for
// it to finish, reads the pod logs, and parses the sentinel-delimited result.
//
// Selected only when TELLUS_UDF_RUNTIME=k8s; otherwise UDF execution is not
// available and callers fall back (preview returns a typed "sandbox not
// configured" envelope). There is no in-process eval path by design — running
// user code without the gVisor sandbox is exactly the risk §1/§3 removed.
// ---------------------------------------------------------------------------

import {
  buildUdfJobManifest,
  buildUdfDenyAllEgressPolicy,
  parseUdfResult,
  udfJobName,
  udfRuntimeOptionsFromEnv,
  type UdfJobInput,
  type UdfRuntimeOptions,
} from "./udfTransform";
import { AppError } from "../../utils/foundryAppError";

export class UdfSandboxUnavailable extends AppError {
  constructor(detail: string) {
    super(
      `UDF sandbox unavailable: ${detail}. Set TELLUS_UDF_RUNTIME=k8s with a cluster that has the gvisor RuntimeClass.`,
      503,
      "UDF_SANDBOX_UNAVAILABLE",
    );
  }
}

interface UdfK8sClient {
  createJob(ns: string, body: unknown): Promise<unknown>;
  readJobStatus(name: string, ns: string): Promise<{ status?: JobStatus }>;
  deleteJob(name: string, ns: string): Promise<unknown>;
  createNetPol(ns: string, body: unknown): Promise<unknown>;
  deleteNetPol(name: string, ns: string): Promise<unknown>;
  listPodsForJob(name: string, ns: string): Promise<string[]>;
  readPodLog(pod: string, ns: string): Promise<string>;
}

interface JobStatus {
  succeeded?: number;
  failed?: number;
  conditions?: Array<{ type?: string; status?: string; reason?: string }>;
}

async function loadClient(): Promise<UdfK8sClient> {
  let mod: typeof import("@kubernetes/client-node");
  try {
    mod = await import("@kubernetes/client-node");
  } catch {
    throw new UdfSandboxUnavailable("@kubernetes/client-node is not installed");
  }
  const kc = new mod.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }
  const batch = kc.makeApiClient(mod.BatchV1Api);
  const core = kc.makeApiClient(mod.CoreV1Api);
  const net = kc.makeApiClient(mod.NetworkingV1Api);
  return {
    createJob: (ns, body) =>
      (batch as unknown as {
        createNamespacedJob: (ns: string, b: unknown) => Promise<unknown>;
      }).createNamespacedJob(ns, body),
    readJobStatus: async (name, ns) => {
      const res = await (batch as unknown as {
        readNamespacedJobStatus: (
          n: string,
          ns: string,
        ) => Promise<{ body: { status?: JobStatus } }>;
      }).readNamespacedJobStatus(name, ns);
      return res.body;
    },
    deleteJob: (name, ns) =>
      (batch as unknown as {
        deleteNamespacedJob: (n: string, ns: string, ...a: unknown[]) => Promise<unknown>;
      }).deleteNamespacedJob(name, ns, undefined, undefined, undefined, undefined, "Background"),
    createNetPol: (ns, body) =>
      (net as unknown as {
        createNamespacedNetworkPolicy: (ns: string, b: unknown) => Promise<unknown>;
      }).createNamespacedNetworkPolicy(ns, body),
    deleteNetPol: (name, ns) =>
      (net as unknown as {
        deleteNamespacedNetworkPolicy: (n: string, ns: string) => Promise<unknown>;
      }).deleteNamespacedNetworkPolicy(name, ns),
    listPodsForJob: async (name, ns) => {
      const res = await (core as unknown as {
        listNamespacedPod: (
          ns: string,
          ...a: unknown[]
        ) => Promise<{ body: { items: Array<{ metadata?: { name?: string } }> } }>;
      }).listNamespacedPod(ns, undefined, undefined, undefined, undefined, `job-name=${name}`);
      return res.body.items.map((p) => p.metadata?.name ?? "").filter(Boolean);
    },
    readPodLog: async (pod, ns) => {
      const res = await (core as unknown as {
        readNamespacedPodLog: (
          n: string,
          ns: string,
        ) => Promise<{ body: string }>;
      }).readNamespacedPodLog(pod, ns);
      return typeof res.body === "string" ? res.body : String(res.body);
    },
  };
}

function isTerminal(
  status: JobStatus,
): { ok: boolean; reason?: string } | null {
  const conds = status.conditions ?? [];
  const failed = conds.find((c) => c.type === "Failed" && c.status === "True");
  if (failed) return { ok: false, reason: failed.reason ?? "Failed" };
  const complete = conds.find(
    (c) => c.type === "Complete" && c.status === "True",
  );
  if (complete || (status.succeeded ?? 0) > 0) return { ok: true };
  if ((status.failed ?? 0) > 0) return { ok: false, reason: "PodFailed" };
  return null;
}

const POLL_MS = Number(process.env.TELLUS_UDF_POLL_MS ?? "2000");

/**
 * Run a UDF transform inside the gVisor sandbox and return the transformed
 * rows. Applies the deny-all egress policy, creates the Job, waits for
 * completion (bounded by the spec timeout + a grace margin), reads the pod
 * logs and parses the result. Cleans up the Job + NetworkPolicy on the way out.
 */
export async function runUdfTransform(
  input: UdfJobInput,
  optsOverride?: Partial<UdfRuntimeOptions>,
): Promise<Array<Record<string, unknown>>> {
  if ((process.env.TELLUS_UDF_RUNTIME ?? "off") !== "k8s") {
    throw new UdfSandboxUnavailable("TELLUS_UDF_RUNTIME is not 'k8s'");
  }
  const opts = { ...udfRuntimeOptionsFromEnv(), ...optsOverride };
  const client = await loadClient();
  const name = udfJobName(input.buildRid);
  const job = buildUdfJobManifest(input, opts);
  const netpol = buildUdfDenyAllEgressPolicy(input, opts);

  await client
    .createNetPol(opts.namespace, netpol)
    .catch(() => undefined); // best-effort; gVisor is the primary control
  await client.createJob(opts.namespace, job);

  const deadline =
    Date.now() + input.spec.timeoutMs + 30_000; /* grace for scheduling */
  try {
    for (;;) {
      if (Date.now() > deadline) {
        throw new AppError("UDF job timed out", 504, "UDF_TIMEOUT");
      }
      await sleep(POLL_MS);
      const body = await client.readJobStatus(name, opts.namespace);
      const term = isTerminal(body.status ?? {});
      if (!term) continue;
      const pods = await client.listPodsForJob(name, opts.namespace);
      const logs = pods.length
        ? await client.readPodLog(pods[0], opts.namespace).catch(() => "")
        : "";
      if (!term.ok) {
        throw new AppError(
          `UDF job failed (${term.reason}). ${logs.slice(-500)}`,
          422,
          "UDF_FAILED",
        );
      }
      return parseUdfResult(logs);
    }
  } finally {
    await client.deleteJob(name, opts.namespace).catch(() => undefined);
    await client
      .deleteNetPol(`${name}-deny-egress`, opts.namespace)
      .catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
