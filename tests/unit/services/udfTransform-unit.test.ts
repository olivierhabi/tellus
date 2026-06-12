import { describe, it, expect } from "vitest";
import {
  validateUdfSpec,
  buildUdfJobManifest,
  buildUdfDenyAllEgressPolicy,
  parseUdfResult,
  pythonHarness,
  javascriptHarness,
  udfJobName,
  UDF_RESULT_BEGIN,
  UDF_RESULT_END,
  type UdfRuntimeOptions,
  type UdfJobInput,
} from "../../../src/services/pipelines/udfTransform";

const OPTS: UdfRuntimeOptions = {
  namespace: "tellus-udf",
  runtimeClassName: "gvisor",
  pythonImage: "python:3.12-slim",
  nodeImage: "node:22-slim",
  workerUid: 65534,
  workerGid: 65534,
  cpuRequest: "100m",
  cpuLimit: "1",
  memRequest: "128Mi",
  memLimit: "512Mi",
  ttlSecondsAfterFinished: 600,
  scratchSizeLimit: "256Mi",
  nodeName: "k3d-substrate-server-0",
};

function pyInput(): UdfJobInput {
  return {
    buildRid: "udf-preview-pipe-1:node-7",
    tenant: "acme",
    spec: {
      function: "Udf",
      language: "python",
      code: "def transform(row):\n    row['total'] = row['qty'] * row['price']\n    return row\n",
      entrypoint: "transform",
      outputColumns: [{ name: "total", type: "numeric" }],
      timeoutMs: 60000,
    },
    rows: [{ qty: 2, price: 3 }],
  };
}

describe("validateUdfSpec", () => {
  it("normalizes a valid python spec", () => {
    const s = validateUdfSpec({
      language: "python",
      code: "def transform(r): return r",
      outputColumns: [{ name: "x", type: "integer" }],
    });
    expect(s.function).toBe("Udf");
    expect(s.language).toBe("python");
    expect(s.entrypoint).toBe("transform"); // default
    expect(s.timeoutMs).toBe(60000); // default
  });

  it("rejects an unknown language", () => {
    expect(() => validateUdfSpec({ language: "ruby", code: "x" })).toThrowError(
      /UDF language must be one of/,
    );
  });

  it("rejects empty code", () => {
    expect(() => validateUdfSpec({ language: "python", code: "   " })).toThrowError(
      /UDF code is required/,
    );
  });

  it("rejects a non-identifier entrypoint", () => {
    expect(() =>
      validateUdfSpec({ language: "python", code: "x=1", entrypoint: "no spaces" }),
    ).toThrowError(/valid identifier/);
  });

  it("clamps the timeout to the hard ceiling", () => {
    const s = validateUdfSpec({
      language: "javascript",
      code: "function transform(r){return r}",
      timeoutMs: 9_999_999,
    });
    expect(s.timeoutMs).toBe(15 * 60 * 1000);
  });
});

describe("buildUdfJobManifest — gVisor sandbox shape", () => {
  const job = buildUdfJobManifest(pyInput(), OPTS) as any;
  const pod = job.spec.template.spec;
  const ctr = pod.containers[0];

  it("is a backoffLimit:0 Job in the udf namespace", () => {
    expect(job.kind).toBe("Job");
    expect(job.spec.backoffLimit).toBe(0);
    expect(job.metadata.namespace).toBe("tellus-udf");
  });

  it("pins the pod to the gvisor RuntimeClass", () => {
    expect(pod.runtimeClassName).toBe("gvisor");
  });

  it("hardens the pod: non-root, read-only rootfs, drop ALL, no SA token", () => {
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    expect(pod.securityContext.runAsUser).toBe(65534);
    expect(ctr.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(ctr.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(ctr.securityContext.capabilities.drop).toEqual(["ALL"]);
    expect(pod.securityContext.seccompProfile.type).toBe("RuntimeDefault");
  });

  it("derives activeDeadlineSeconds from the UDF timeout", () => {
    expect(job.spec.activeDeadlineSeconds).toBe(60);
  });

  it("runs python with the harness program and base64 input env", () => {
    expect(ctr.image).toBe("python:3.12-slim");
    expect(ctr.command[0]).toBe("python3");
    expect(ctr.command[1]).toBe("-c");
    expect(ctr.command[2]).toContain("def transform(row):");
    const inputEnv = ctr.env.find((e: any) => e.name === "TELLUS_UDF_INPUT");
    expect(inputEnv).toBeTruthy();
    const decoded = JSON.parse(
      Buffer.from(inputEnv.value, "base64").toString("utf8"),
    );
    expect(decoded).toEqual([{ qty: 2, price: 3 }]);
  });

  it("selects the node image for javascript UDFs", () => {
    const jsInput = pyInput();
    jsInput.spec.language = "javascript";
    jsInput.spec.code = "function transform(r){return r}";
    const j = buildUdfJobManifest(jsInput, OPTS) as any;
    const c = j.spec.template.spec.containers[0];
    expect(c.image).toBe("node:22-slim");
    expect(c.command[0]).toBe("node");
  });
});

describe("buildUdfDenyAllEgressPolicy", () => {
  it("denies ALL egress (empty egress rule list, not even DNS)", () => {
    const np = buildUdfDenyAllEgressPolicy(pyInput(), OPTS) as any;
    expect(np.kind).toBe("NetworkPolicy");
    expect(np.spec.policyTypes).toEqual(["Egress"]);
    expect(np.spec.egress).toEqual([]);
    expect(np.metadata.name).toBe(`${udfJobName(pyInput().buildRid)}-deny-egress`);
  });
});

describe("harness + parseUdfResult round-trip", () => {
  it("python harness embeds the user code and entrypoint", () => {
    const h = pythonHarness("def f(r): return r", "f");
    expect(h).toContain("def f(r): return r");
    expect(h).toContain('globals().get("f")');
  });

  it("javascript harness embeds the user code and entrypoint", () => {
    const h = javascriptHarness("function g(r){return r}", "g");
    expect(h).toContain("function g(r){return r}");
    expect(h).toContain("typeof g");
  });

  it("parses the sentinel-delimited result from pod logs", () => {
    const logs = `some startup noise\n${UDF_RESULT_BEGIN}\n[{"total":6}]\n${UDF_RESULT_END}\ntrailing`;
    expect(parseUdfResult(logs)).toEqual([{ total: 6 }]);
  });

  it("throws UDF_NO_RESULT when sentinels are missing", () => {
    expect(() => parseUdfResult("traceback: boom")).toThrowError(
      /no result block/,
    );
  });

  it("throws UDF_BAD_RESULT when the block is not a JSON array", () => {
    const logs = `${UDF_RESULT_BEGIN}\n{"not":"array"}\n${UDF_RESULT_END}`;
    expect(() => parseUdfResult(logs)).toThrowError(/array of rows/);
  });
});
