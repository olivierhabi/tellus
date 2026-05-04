// B7 — JobSpec validation unit tests.

import { describe, it, expect } from "vitest";
import {
  validateEntryPoint,
  validateDatasetRid,
  validateCommitSha,
  validateBranch,
  validateJobSpec,
  detectCircularDependencies,
  type JobSpecPayload,
} from "../../../../src/services/jobSpec/validation.js";

const VALID_RID = "ri.foundry.main.dataset.0123abcd-ef01-4234-8567-89abcdef0123";

describe("validateEntryPoint", () => {
  it("accepts module:function form", () => {
    expect(validateEntryPoint("my_pkg.datasets.foo:compute").ok).toBe(true);
  });
  it("accepts module-only form", () => {
    expect(validateEntryPoint("my_pkg.datasets.foo").ok).toBe(true);
  });
  it("rejects empty string", () => {
    const r = validateEntryPoint("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorName).toBe("JobSpec:InvalidEntryPoint");
  });
  it("rejects malformed (starts with digit)", () => {
    const r = validateEntryPoint("9bad:name");
    expect(r.ok).toBe(false);
  });
  it("rejects too long", () => {
    const r = validateEntryPoint("a".repeat(500));
    expect(r.ok).toBe(false);
  });
  it("rejects bad function part", () => {
    const r = validateEntryPoint("my_pkg:9bad");
    expect(r.ok).toBe(false);
  });
});

describe("validateDatasetRid", () => {
  it("accepts a well-formed rid", () => {
    expect(validateDatasetRid(VALID_RID, "x").ok).toBe(true);
  });
  it("rejects a malformed rid", () => {
    expect(validateDatasetRid("not-a-rid", "x").ok).toBe(false);
  });
  it("rejects rid with wrong namespace prefix", () => {
    expect(validateDatasetRid("https://example.com", "x").ok).toBe(false);
  });
});

describe("validateCommitSha", () => {
  it("accepts 40-hex sha", () => expect(validateCommitSha("a".repeat(40)).ok).toBe(true));
  it("accepts 7-hex (short sha)", () => expect(validateCommitSha("abcdef0").ok).toBe(true));
  it("rejects too short", () => expect(validateCommitSha("abc").ok).toBe(false));
  it("rejects non-hex", () => expect(validateCommitSha("ZZZZZZZ").ok).toBe(false));
});

describe("validateBranch", () => {
  it("accepts main", () => expect(validateBranch("main").ok).toBe(true));
  it("accepts feature/x", () => expect(validateBranch("feature/x").ok).toBe(true));
  it("rejects empty", () => expect(validateBranch("").ok).toBe(false));
  it("rejects spaces", () => expect(validateBranch("with space").ok).toBe(false));
});

describe("validateJobSpec", () => {
  const ok: JobSpecPayload = {
    outputDatasetRid: VALID_RID,
    sourcePath: "transforms/example.py",
    entryPoint: "example:compute",
    inputs: [{ datasetRid: VALID_RID + "X", branch: "main", view: "snapshot" }],
    parameters: {},
    computeProfile: "default",
  };
  it("accepts a fully valid spec", () => {
    const inputDifferentRid = "ri.foundry.main.dataset.0123abcd-ef01-4234-8567-89abcdef9999";
    expect(validateJobSpec({ ...ok, inputs: [{ datasetRid: inputDifferentRid, branch: "main", view: "snapshot" }] }).ok).toBe(true);
  });
  it("rejects bad output rid", () => {
    expect(validateJobSpec({ ...ok, outputDatasetRid: "bad" }).ok).toBe(false);
  });
  it("rejects bad input rid", () => {
    const r = validateJobSpec({
      ...ok,
      inputs: [{ datasetRid: "bad", branch: "main", view: "snapshot" }],
    });
    expect(r.ok).toBe(false);
  });
  it("rejects bad view enum", () => {
    const r = validateJobSpec({
      ...ok,
      inputs: [{ datasetRid: VALID_RID, branch: "main", view: "bogus" as "snapshot" }],
    });
    expect(r.ok).toBe(false);
  });
  it("rejects empty source path", () => {
    expect(validateJobSpec({ ...ok, sourcePath: "" }).ok).toBe(false);
  });
});

describe("detectCircularDependencies", () => {
  const A = "ri.foundry.main.dataset.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "ri.foundry.main.dataset.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const C = "ri.foundry.main.dataset.cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  function spec(out: string, ins: string[]): JobSpecPayload {
    return {
      outputDatasetRid: out,
      sourcePath: "x.py",
      entryPoint: "x:f",
      inputs: ins.map((rid) => ({ datasetRid: rid, branch: "main", view: "snapshot" as const })),
      parameters: {},
      computeProfile: "default",
    };
  }

  it("ok: linear chain A → B → C (no cycles)", () => {
    const r = detectCircularDependencies([spec(B, [A]), spec(C, [B])]);
    expect(r.ok).toBe(true);
  });

  it("rejects self-loop (output is in own inputs)", () => {
    const r = detectCircularDependencies([spec(A, [A])]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("JobSpec:CircularDependency");
      expect(r.parameters.reason).toBe("self-loop");
    }
  });

  it("rejects 2-cycle: A→B and B→A", () => {
    const r = detectCircularDependencies([spec(A, [B]), spec(B, [A])]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.parameters.reason).toBe("transitive-cycle");
  });

  it("rejects 3-cycle: A→B, B→C, C→A", () => {
    const r = detectCircularDependencies([spec(A, [B]), spec(B, [C]), spec(C, [A])]);
    expect(r.ok).toBe(false);
  });

  it("ignores inputs not in the published batch (external datasets)", () => {
    // A reads from external (not published in this batch); ok.
    const EXT = "ri.foundry.main.dataset.eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const r = detectCircularDependencies([spec(A, [EXT])]);
    expect(r.ok).toBe(true);
  });
});
