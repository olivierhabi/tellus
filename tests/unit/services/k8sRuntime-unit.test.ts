import { describe, it, expect } from "vitest";
import {
  jobName,
  jobLabels,
  buildJobManifest,
  buildEgressNetworkPolicy,
  classifyJobStatus,
  type K8sRuntimeOptions,
} from "../../../src/services/orchestration/runners/k8s-manifests";
import type { JobSpec } from "../../../src/services/orchestration/runners/runtime-adapter";

const SPEC: JobSpec = {
  buildRid: "ri.foundry.main.build.AbC-123:xyz",
  importRid: "ri.foundry.main.import.42",
  connectionRid: "ri.connection.main.pg.7",
  tenant: "acme-corp",
  actor: "user@acme.example",
  kind: "foundryWorker",
  egress: {
    allow: [
      { host: "db.acme.example", port: 5432 },
      { host: "db.acme.example", port: 5432 },
    ],
    cidrs: ["10.20.0.0/16"],
  },
  workloadJwt: "eyJ.workload.jwt",
  payload: { strategy: "snapshot" },
  deadlineMs: 90_000,
};

const OPTS: K8sRuntimeOptions = {
  namespace: "tellus-workers",
  image: "ghcr.io/tellus/foundry-worker:1.2.3",
  runtimeClassName: "gvisor",
  workerUid: 65534,
  workerGid: 65534,
  cpuRequest: "250m",
  cpuLimit: "2",
  memRequest: "512Mi",
  memLimit: "2048Mi",
  ttlSecondsAfterFinished: 3600,
  scratchSizeLimit: "2Gi",
  passthroughEnv: { NODE_ENV: "production", TELLUS_INTERNAL_URL: "http://api:3000" },
};

// Reach into the manifest with loose typing — these are plain JSON objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const podSpec = (m: Record<string, unknown>): any =>
  (m.spec as any).template.spec;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const container = (m: Record<string, unknown>): any => podSpec(m).containers[0];

describe("jobName", () => {
  it("is DNS-1123 safe, <=63 chars, ends alphanumeric", () => {
    const name = jobName(SPEC.buildRid);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(name.startsWith("tellus-build-")).toBe(true);
  });

  it("is deterministic and collision-resistant across similar RIDs", () => {
    expect(jobName(SPEC.buildRid)).toBe(jobName(SPEC.buildRid));
    // Two RIDs that slugify identically must still differ (content hash).
    expect(jobName("ri.build.a/b")).not.toBe(jobName("ri.build.a-b"));
  });

  it("clamps very long RIDs to the DNS limit", () => {
    const name = jobName("x".repeat(500));
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });
});

describe("buildJobManifest — gVisor sandbox", () => {
  const m = buildJobManifest(SPEC, OPTS);

  it("pins the pod to the gVisor RuntimeClass", () => {
    expect(podSpec(m).runtimeClassName).toBe("gvisor");
  });

  it("hardens the pod and container security context", () => {
    expect(podSpec(m).securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 65534,
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(container(m).securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      privileged: false,
      readOnlyRootFilesystem: true,
      runAsNonRoot: true,
      capabilities: { drop: ["ALL"] },
    });
    expect(podSpec(m).automountServiceAccountToken).toBe(false);
  });

  it("carries the JobSpec and workload JWT via env (entrypoint unchanged)", () => {
    const env: Array<{ name: string; value: string }> = container(m).env;
    const byName = Object.fromEntries(env.map((e) => [e.name, e.value]));
    expect(JSON.parse(byName.TELLUS_JOB_SPEC).buildRid).toBe(SPEC.buildRid);
    expect(byName.TELLUS_WORKLOAD_JWT).toBe(SPEC.workloadJwt);
    expect(byName.NODE_ENV).toBe("production");
    expect(byName.TELLUS_INTERNAL_URL).toBe("http://api:3000");
  });

  it("does not retry user code and enforces the soft deadline", () => {
    expect((m.spec as Record<string, unknown>).backoffLimit).toBe(0);
    expect((m.spec as Record<string, unknown>).activeDeadlineSeconds).toBe(90); // 90_000ms
    expect((m.spec as Record<string, unknown>).ttlSecondsAfterFinished).toBe(3600);
    expect(podSpec(m).restartPolicy).toBe("Never");
  });

  it("mounts a writable scratch dir over the read-only rootfs", () => {
    expect(container(m).volumeMounts).toEqual([
      { name: "scratch", mountPath: "/tmp" },
    ]);
    expect(podSpec(m).volumes[0].emptyDir.sizeLimit).toBe("2Gi");
  });

  it("sets resource requests and limits", () => {
    expect(container(m).resources).toEqual({
      requests: { cpu: "250m", memory: "512Mi" },
      limits: { cpu: "2", memory: "2048Mi" },
    });
  });

  it("stamps identifying labels", () => {
    const labels = jobLabels(SPEC);
    expect(labels["app.kubernetes.io/name"]).toBe("tellus-foundry-worker");
    expect(labels["tellus.io/tenant"]).toBe("acme-corp");
    // build-rid label is sanitized to label-safe chars.
    expect(labels["tellus.io/build-rid"]).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*[a-zA-Z0-9]$/);
  });
});

describe("buildEgressNetworkPolicy — default-deny egress", () => {
  const np = buildEgressNetworkPolicy(SPEC, OPTS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spec = np.spec as any;

  it("scopes to this job's pod and is egress-only", () => {
    expect(spec.podSelector.matchLabels["tellus.io/build-rid"]).toBeDefined();
    expect(spec.policyTypes).toEqual(["Egress"]);
  });

  it("always allows DNS", () => {
    const dns = spec.egress[0];
    expect(dns.ports).toEqual([
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ]);
  });

  it("allows the JobSpec CIDRs on the deduped allow-list ports", () => {
    const rule = spec.egress[1];
    expect(rule.to).toEqual([{ ipBlock: { cidr: "10.20.0.0/16" } }]);
    // 5432 appears twice in the spec — must be deduped.
    expect(rule.ports).toEqual([{ protocol: "TCP", port: 5432 }]);
  });

  it("falls back to ports-only when no CIDRs are given", () => {
    const np2 = buildEgressNetworkPolicy(
      { ...SPEC, egress: { allow: [{ host: "x", port: 443 }], cidrs: [] } },
      OPTS,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rule = (np2.spec as any).egress[1];
    expect(rule.to).toBeUndefined();
    expect(rule.ports).toEqual([{ protocol: "TCP", port: 443 }]);
  });
});

describe("classifyJobStatus", () => {
  it("returns null while running", () => {
    expect(classifyJobStatus({})).toBeNull();
    expect(classifyJobStatus({ conditions: [] })).toBeNull();
  });

  it("maps Complete -> succeeded", () => {
    expect(
      classifyJobStatus({
        succeeded: 1,
        conditions: [{ type: "Complete", status: "True" }],
      }),
    ).toEqual({ kind: "succeeded" });
  });

  it("maps Failed -> failed with reason", () => {
    expect(
      classifyJobStatus({
        failed: 1,
        conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }],
      }),
    ).toEqual({ kind: "failed", reason: "BackoffLimitExceeded" });
  });

  it("maps DeadlineExceeded -> timeout", () => {
    expect(
      classifyJobStatus({
        failed: 1,
        conditions: [{ type: "Failed", status: "True", reason: "DeadlineExceeded" }],
      }),
    ).toEqual({ kind: "timeout", reason: "DeadlineExceeded" });
  });
});
