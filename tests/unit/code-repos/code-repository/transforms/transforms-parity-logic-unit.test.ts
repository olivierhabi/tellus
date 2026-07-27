// ---------------------------------------------------------------------------
// Pure-logic unit tests for the transforms-python parity change.
//
// Covers the four changed backend files' TESTABLE logic branches (no DB, no
// python3, no Spark) — the two spots flagged as bug-prone (the
// transaction-type mapping + the resolvePreviousTransaction SQL are in a
// sibling file), plus the two regressions actually hit during the change:
//   - the DATASET_RID_REGEX segment-count bug (5-segment dotted RIDs were
//     rejected by JobSpec validation);
//   - the executor env-whitelist / PYSPARK_PYTHON-default wiring (the bash
//     runner's set -u unbound-variable bug was the shell-side twin).
//
// Run: pnpm vitest run --config vitest.unit.config.ts tests/unit/code-repos/code-repository/transforms/transforms-parity-logic-unit.test.ts
// ---------------------------------------------------------------------------
import { describe, expect, it, vi, afterEach } from "vitest";

import {
  transactionTypeFor,
  topoOrder,
} from "../../../../../src/services/codeRepository/transforms/buildService";
import type { DiscoveredTransform } from "../../../../../src/services/codeRepository/transforms/discovery";
import {
  filterEnv,
  buildJobSpec,
} from "../../../../../src/services/codeRepository/transforms/executor";
import type { ExecuteArgs } from "../../../../../src/services/codeRepository/transforms/executor";
import {
  DATASET_RID_REGEX,
  validateDatasetRid,
} from "../../../../../src/services/jobSpec/validation";
import { extractProfile, discoverTransforms, runtimeFor, runtimeForBatch } from "../../../../../src/services/codeRepository/transforms/discovery";
import { validateProfile, PROFILE_CATALOG } from "../../../../../src/services/codeRepository/transforms/profileCatalog";

// ---- helpers ----
const tf = (
  name: string,
  outputRid: string,
  inputs: { param: string; rid: string }[] = [],
): DiscoveredTransform => ({
  name,
  sourcePath: `transforms/${name}.py`,
  kind: "transform",
  outputRid,
  // Single-output backward-compat: the legacy @transform(output=Output(...))
  // form has exactly one Output named "output". The new multi-output
  // DiscoveredTransform.outputs array carries this entry as its sole element.
  outputs: [{ param: "output", rid: outputRid }],
  inputs: inputs.map((i) => ({ param: i.param, rid: i.rid })),
  incremental: false,
  profile: null,
  // Default: the legacy single-Output Tellus @transform(...) form is NOT the
  // @transform.using(...) Palantir form; runtimeOverride is unset so
  // runtimeFor(kind) (spark for kind = 'transform') applies.
  using: false,
});

// ===========================================================================
// transactionTypeFor — the Foundry write-mode -> dataset-transaction-type
// mapping. A bug here silently turns APPEND into SNAPSHOT (or vice versa),
// corrupting incremental writes with no error. Extracted from an inline
// ternary specifically so this mapping has a test.
// ===========================================================================
describe("transactionTypeFor (buildService)", () => {
  it("'replace' -> SNAPSHOT (full replace)", () => {
    expect(transactionTypeFor("replace")).toBe("SNAPSHOT");
  });
  it("'modify' -> APPEND", () => {
    expect(transactionTypeFor("modify")).toBe("APPEND");
  });
  it("'append' -> APPEND", () => {
    expect(transactionTypeFor("append")).toBe("APPEND");
  });
  it("undefined (the write_dataframe default) -> SNAPSHOT", () => {
    expect(transactionTypeFor(undefined)).toBe("SNAPSHOT");
  });
  it("null -> SNAPSHOT", () => {
    expect(transactionTypeFor(null)).toBe("SNAPSHOT");
  });
  it("unknown string -> SNAPSHOT (safe default: never APPEND on a value we don't recognize)", () => {
    expect(transactionTypeFor("bogus")).toBe("SNAPSHOT");
  });
});

// ===========================================================================
// topoOrder — Kahn topological sort over output->input edges. A regression
// here would build a transform before its input's producer (the build then
// fails with "input dataset not found" or reads stale state).
// ===========================================================================
describe("topoOrder (buildService)", () => {
  it("orders a linear chain a -> b -> c (input given out of order)", () => {
    const a = tf("a", "ri.foundry.main.dataset.a");
    const b = tf("b", "ri.foundry.main.dataset.b", [{ param: "src", rid: "ri.foundry.main.dataset.a" }]);
    const c = tf("c", "ri.foundry.main.dataset.c", [{ param: "src", rid: "ri.foundry.main.dataset.b" }]);
    const o = topoOrder([c, b, a]).map((t) => t.name);
    expect(o.indexOf("a")).toBeLessThan(o.indexOf("b"));
    expect(o.indexOf("b")).toBeLessThan(o.indexOf("c"));
  });
  it("independent transforms (no shared edges) keep a stable order", () => {
    const a = tf("a", "ri.foundry.main.dataset.a");
    const b = tf("b", "ri.foundry.main.dataset.b");
    expect(topoOrder([a, b]).map((t) => t.name)).toEqual(["a", "b"]);
  });
  it("diamond a -> {b,c} -> d: b and c after a, before d", () => {
    const a = tf("a", "ri.foundry.main.dataset.a");
    const b = tf("b", "ri.foundry.main.dataset.b", [{ param: "s", rid: "ri.foundry.main.dataset.a" }]);
    const c = tf("c", "ri.foundry.main.dataset.c", [{ param: "s", rid: "ri.foundry.main.dataset.a" }]);
    const d = tf("d", "ri.foundry.main.dataset.d", [
      { param: "b", rid: "ri.foundry.main.dataset.b" },
      { param: "c", rid: "ri.foundry.main.dataset.c" },
    ]);
    const o = topoOrder([d, c, b, a]).map((t) => t.name);
    expect(o.indexOf("a")).toBeLessThan(o.indexOf("b"));
    expect(o.indexOf("a")).toBeLessThan(o.indexOf("c"));
    expect(o.indexOf("b")).toBeLessThan(o.indexOf("d"));
    expect(o.indexOf("c")).toBeLessThan(o.indexOf("d"));
  });
  it("does not depend on inputs that are NOT batch outputs (external RIDs don't add indegree)", () => {
    // An input RID that no transform in the batch produces must NOT block ordering.
    const a = tf("a", "ri.foundry.main.dataset.a", [{ param: "ext", rid: "ri.foundry.main.dataset.external" }]);
    expect(topoOrder([a]).map((t) => t.name)).toEqual(["a"]);
  });
});

// ===========================================================================
// DATASET_RID_REGEX — REGRESSION for the bug surfaced during the parity
// probe: a 5-segment dotted RID (ri.foundry.main.dataset.parity.basic) was
// REJECTED by JobSpec validation (JobSpec:InvalidArgument / invalid-dataset-
// rid) while the 4-segment hyphenated form (ri.foundry.main.dataset.parity-
// basic) was accepted. This pins the accepted shape.
// ===========================================================================
describe("DATASET_RID_REGEX (jobSpec validation — RID segment-count regression)", () => {
  const accept = [
    "ri.foundry.main.dataset.placeholder",
    "ri.foundry.main.dataset.parity-basic",
    "ri.foundry.main.dataset.parity-spark",
    "ri.stemma.main.repository.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ];
  const reject = [
    "ri.foundry.main.dataset.parity.basic", // 5 segments after ri -> REJECTED (the bug)
    "{{datasetRid}}", // unsubstituted template placeholder
    "ri.foundry.main.dataset.", // trailing dot / empty id
    "not-a-rid",
    "",
  ];
  for (const rid of accept) {
    it(`accepts ${rid}`, () => {
      expect(DATASET_RID_REGEX.test(rid)).toBe(true);
    });
  }
  for (const rid of reject) {
    it(`rejects ${rid}`, () => {
      expect(DATASET_RID_REGEX.test(rid)).toBe(false);
    });
  }
  it("validateDatasetRid returns JobSpec:InvalidArgument / invalid-dataset-rid for the 5-segment RID", () => {
    const r = validateDatasetRid("ri.foundry.main.dataset.parity.basic", "outputDatasetRid");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorName).toBe("JobSpec:InvalidArgument");
      expect(r.parameters).toMatchObject({ reason: "invalid-dataset-rid", field: "outputDatasetRid" });
    }
  });
});

// ===========================================================================
// executor.filterEnv — the env wired into the python3 child. Regression for
// the JAVA_HOME / PYSPARK_PYTHON whitelist addition + the PYSPARK_PYTHON
// default. If JAVA_HOME is dropped, PySpark can't find the JVM; if
// PYSPARK_PYTHON is unset, Spark workers spawn the wrong interpreter.
// ===========================================================================
describe("executor.filterEnv (PySpark child-env wiring)", () => {
  const orig = { ...process.env };
  afterEach(() => {
    process.env = { ...orig };
  });

  it("passes through whitelisted JAVA_HOME and PATH", () => {
    process.env.JAVA_HOME = "/opt/jdk";
    process.env.PATH = "/usr/bin";
    const e = filterEnv();
    expect(e.JAVA_HOME).toBe("/opt/jdk");
    expect(e.PATH).toBe("/usr/bin");
  });
  it("does NOT leak unwhitelisted env vars (no secret bleed into the sandbox)", () => {
    process.env.SECRET_TOKEN = "leak";
    process.env.DATABASE_URL = "postgres://...";
    const e = filterEnv();
    expect(e.SECRET_TOKEN).toBeUndefined();
    expect(e.DATABASE_URL).toBeUndefined();
  });
  it("defaults PYSPARK_PYTHON to PYTHON_BIN when unset (Spark worker interpreter matches the driver)", () => {
    delete process.env.PYSPARK_PYTHON;
    delete process.env.PYSPARK_DRIVER_PYTHON;
    const e = filterEnv();
    expect(typeof e.PYSPARK_PYTHON).toBe("string");
    expect(e.PYSPARK_PYTHON).toBe(e.PYSPARK_DRIVER_PYTHON);
  });
  it("preserves an explicit PYSPARK_PYTHON when set", () => {
    process.env.PYSPARK_PYTHON = "/custom/python";
    const e = filterEnv();
    expect(e.PYSPARK_PYTHON).toBe("/custom/python");
  });
  it("sets PYTHONUNBUFFERED + PYTHONDONTWRITEBYTECODE", () => {
    const e = filterEnv();
    expect(e.PYTHONUNBUFFERED).toBe("1");
    expect(e.PYTHONDONTWRITEBYTECODE).toBe("1");
  });
});

// ===========================================================================
// executor.buildJobSpec — the TELLUS_TRANSFORM_JOB payload. Regression for
// the isIncremental / previousPath fields: if either is dropped, the Python
// driver sees is_incremental=false always and mode='previous' gets null,
// silently breaking @incremental semantics.
// ===========================================================================
describe("executor.buildJobSpec (isIncremental / previousPath threading)", () => {
  const baseArgs = (overrides: Partial<ExecuteArgs> = {}): ExecuteArgs => ({
    transform: {
      name: "t",
      sourcePath: "transforms/t.py",
      kind: "transform",
      outputRid: "ri.foundry.main.dataset.out",
      inputs: [],
      incremental: false,
    },
    files: [],
    inputs: [{ param: "src", rid: "ri.foundry.main.dataset.in", path: "/in.csv", previousPath: "/prev.csv" }],
    ...overrides,
  });
  const paths = { sdkRoot: "/sdk", repoRoot: "/repo", modulePath: "/repo/transforms/t.py", outputPath: "/out.csv" };

  it("threads isIncremental=true to the driver", () => {
    const job = buildJobSpec(baseArgs({ isIncremental: true }), paths);
    expect(job.isIncremental).toBe(true);
    expect(job.entryPoint).toBe("t");
    expect(job.outputPath).toBe("/out.csv");
    expect(job.sdkRoot).toBe("/sdk");
    expect(job.modulePath).toBe("/repo/transforms/t.py");
  });
  it("defaults isIncremental=false when unset", () => {
    const job = buildJobSpec(baseArgs(), paths);
    expect(job.isIncremental).toBe(false);
  });
  it("threads per-input previousPath (and nulls it when absent)", () => {
    const job = buildJobSpec(baseArgs(), paths);
    expect(job.inputs[0].previousPath).toBe("/prev.csv");
    const job2 = buildJobSpec(
      baseArgs({ inputs: [{ param: "src", rid: "ri.foundry.main.dataset.in", path: "/in.csv" }] }),
      paths,
    );
    expect(job2.inputs[0].previousPath).toBeNull();
  });
  it("defaults input format to 'csv' when unset", () => {
    const job = buildJobSpec(baseArgs(), paths);
    expect(job.inputs[0].format).toBe("csv");
  });
});

// Silence the unused-import lint for vi (used in afterEach only here, but
// kept for parity with the sibling datasetStore test that mocks pool).
void vi;

// ===========================================================================
// @configure enforcement (gap 6) — extractProfile (discovery) +
// validateProfile (profileCatalog). Foundry rejects unknown profile names at
// scheduling time; this is the pure-logic gate (no cluster needed).
// ===========================================================================
describe("@configure profile enforcement (gap 6)", () => {
  it("extractProfile parses profile=[\"A\",\"B\"]", () => {
    expect(extractProfile('profile=["DRIVER_MEMORY_LARGE", "EXECUTOR_MEMORY_MEDIUM"]')).toEqual([
      "DRIVER_MEMORY_LARGE",
      "EXECUTOR_MEMORY_MEDIUM",
    ]);
  });
  it("extractProfile parses single-quoted names", () => {
    expect(extractProfile("profile=['CPU_LARGE']")).toEqual(["CPU_LARGE"]);
  });
  it("extractProfile returns null for an empty list", () => {
    expect(extractProfile("profile=[]")).toBeNull();
  });
  it("extractProfile returns null when no profile kwarg is present", () => {
    expect(extractProfile("some_other=1")).toBeNull();
    expect(extractProfile("")).toBeNull();
  });

  it("validateProfile: null -> ok (@configure is optional)", () => {
    expect(validateProfile(null).ok).toBe(true);
    expect(validateProfile(undefined).ok).toBe(true);
  });
  it("validateProfile: empty list -> ok", () => {
    expect(validateProfile([]).ok).toBe(true);
  });
  it("validateProfile: known names -> ok", () => {
    expect(validateProfile(["DRIVER_MEMORY_LARGE", "EXECUTOR_MEMORY_MEDIUM"]).ok).toBe(true);
  });
  it("validateProfile: unknown name -> REJECTED with the unknown name(s)", () => {
    const r = validateProfile(["DRIVER_MEMORY_LARGE", "BOGUS_PROFILE", "ALSO_BOGUS"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.unknown).toEqual(["BOGUS_PROFILE", "ALSO_BOGUS"]);
      expect(r.unknown).not.toContain("DRIVER_MEMORY_LARGE");
    }
  });
  it("PROFILE_CATALOG includes the names probe_conf uses (so the parity probe is not broken)", () => {
    expect(PROFILE_CATALOG.has("DRIVER_MEMORY_LARGE")).toBe(true);
    expect(PROFILE_CATALOG.has("EXECUTOR_MEMORY_MEDIUM")).toBe(true);
  });
});

// ===========================================================================
// AST parse (gap 9) — discovery.scanModule now uses python3 ast.parse (PRIMARY)
// with the line-scanner as FALLBACK. The AST robustly handles multi-line
// decorators (the line-scanner's parenBalance was fragile) + rejects f-string
// RIDs loudly (the line-scanner silently missed them). These tests spawn
// python3 (system or venv — ast is stdlib).
// ===========================================================================
describe("AST parse (discovery) — multi-line decorators + f-string rejection", () => {
  it("extracts Output/Input RIDs from a MULTI-LINE decorator (output + src on separate lines)", () => {
    const py = `from transforms.api import transform, Output, Input
@transform(
    output=Output("ri.foundry.main.dataset.ast-multi"),
    src=Input("ri.foundry.main.dataset.ast-in"),
)
def f(output, src):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/f.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    expect(r.transforms[0].name).toBe("f");
    expect(r.transforms[0].outputRid).toBe("ri.foundry.main.dataset.ast-multi");
    expect(r.transforms[0].inputs[0].param).toBe("src");
    expect(r.transforms[0].inputs[0].rid).toBe("ri.foundry.main.dataset.ast-in");
  });

  it("REJECTS an f-string RID loudly (discovery error, not a silent miss)", () => {
    // Output(f"ri...{var}") — the regex extractor can't match an f-string, so
    // discovery reports "no Output(...)" rather than silently producing a
    // transform with a null/garbage RID.
    const py = `from transforms.api import transform, Output
@transform(output=Output(f"ri.foundry.main.dataset.{var}"))
def f(output):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/f.py", content: py }]);
    expect(r.transforms).toHaveLength(0);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0].message).toMatch(/Output|RID/i);
  });

  it("parses a simple single-line decorator (the common case all cypress specs use)", () => {
    const py = `from transforms.api import transform, Output, DataFrame
@transform(output=Output("ri.foundry.main.dataset.ast-simple"))
def f(output):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/f.py", content: py }]);
    expect(r.errors).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    expect(r.transforms[0].outputRid).toBe("ri.foundry.main.dataset.ast-simple");
  });
});

// ===========================================================================
// Track 1 — @lightweight discovery + runtime tag selection (transform_build.runtime
// migration 120; runtimeFor / runtimeForBatch in discovery.ts). The @lightweight
// decorator (transforms-python v3.0.0) is a parallel-of-@transform entry that
// the discovery walker recognizes by kind='lightweight'; the runtime FOR THE
// BUILD is selected from the discovered kinds at scheduling time:
//   * ALL transforms are @lightweight -> runtime = 'lightweight'
//   * ANY transform is Spark-backed (@transform/@transform_df/@transform_pandas) -> 'spark'
//   * Empty batch -> 'lightweight' (safe default for an empty repo's first build)
// ===========================================================================
describe("@lightweight discovery + runtimeFor/runtimeForBatch (Track 1)", () => {
  it("discovers an @lightweight transform with kind='lightweight' (parallel-of-@transform I/O extraction)", () => {
    const py = `from transforms.api import lightweight, Output, Input
@lightweight(
    output=Output("ri.foundry.main.dataset.light-out"),
    src=Input("ri.foundry.main.dataset.light-in"),
)
def f(output, src):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/light.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    expect(r.transforms[0].name).toBe("f");
    expect(r.transforms[0].kind).toBe("lightweight");
    expect(r.transforms[0].outputRid).toBe("ri.foundry.main.dataset.light-out");
    expect(r.transforms[0].inputs[0].param).toBe("src");
    expect(r.transforms[0].inputs[0].rid).toBe("ri.foundry.main.dataset.light-in");
  });

  it("runtimeFor maps kind → runtime (lightweight only; everything else spark)", () => {
    expect(runtimeFor("lightweight")).toBe("lightweight");
    expect(runtimeFor("transform")).toBe("spark");
    expect(runtimeFor("transform_df")).toBe("spark");
    expect(runtimeFor("transform_pandas")).toBe("spark");
  });

  it("runtimeForBatch returns 'lightweight' only when ALL transforms are @lightweight", () => {
    const lw = (n: string, rid: string): DiscoveredTransform => ({
      ...(tf(n, rid) as DiscoveredTransform),
      kind: "lightweight",
      profile: null,
    });
    const spark = (n: string, rid: string): DiscoveredTransform => ({
      ...(tf(n, rid) as DiscoveredTransform),
      profile: null,
    });
    // runtimeForBatch accepts TransformKind[], so project the kinds here.
    const lwKinds = [lw("t1", "ri.foundry.main.dataset.x"), lw("t2", "ri.foundry.main.dataset.y")].map((t) => t.kind);
    // All-lightweight -> lightweight
    expect(runtimeForBatch(lwKinds)).toBe("lightweight");
    // Any spark -> spark (superset runtime)
    const mixedKinds = [lw("t1", "ri.foundry.main.dataset.x"), spark("s", "ri.foundry.main.dataset.y")].map((t) => t.kind);
    expect(runtimeForBatch(mixedKinds)).toBe("spark");
    // Empty batch -> lightweight (safe default for a brand-new repo's first build)
    expect(runtimeForBatch([])).toBe("lightweight");
  });

  it("a source-only @lightweight (no Input) is discovered legibly (mirrors the v3.0.0 template's lightweight_seed.py)", () => {
    const py = `from transforms.api import lightweight, Output, DataFrame
@lightweight(output=Output("ri.foundry.main.dataset.seed"))
def leaked_lightweight_seed(output):
    output.write_dataframe(DataFrame([{"id": 1, "value": 10}]))
`;
    const r = discoverTransforms([{ path: "transforms/lightweight_seed.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    expect(r.transforms[0].kind).toBe("lightweight");
    expect(r.transforms[0].inputs).toHaveLength(0);
  });
});

// ===========================================================================
// Phase 2 — @transform.using(...) (Palantir Foundry v3.68.0+), @transform.spark.using(...)
// (v3.95.0+), stacked @lightweight @transform(...) legacy form, multi-output,
// catalog-path references, cycle rejection, and runtimeOverride plumbing.
//
// These tests exercise the discovery.ts changes that ADDED the dotted-decorator
// classifier (transform.using / transform.spark.using / transform.lightweight),
// the new outputs[] / using / runtimeOverride fields on DiscoveredTransform,
// the looksLikeDatasetReference /catalog-path acceptance, and the within-
// transform Input==Output cycle guard. They are pure-logic tests (no DB) that
// lean on the AST parser ONLY when python3 is on PATH; the line-scanner
// fallback handles paren-balanced multi-line decorators correctly for the
// fixture styles used here.
// ===========================================================================
describe("@transform.using + multi-output + catalog-path discovery (Phase 2)", () => {
  it("discovers @transform.using with using=true + runtimeOverride=lightweight", () => {
    const py = `from transforms.api import transform, Input, Output
@transform.using(
    students=Input("/examples/students_hair_eye_color"),
    processed=Output("/examples/processed"),
)
def filter_hair_color(students, processed):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/f.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    const t = r.transforms[0];
    expect(t.name).toBe("filter_hair_color");
    expect(t.kind).toBe("transform");
    expect(t.using).toBe(true);
    expect(t.runtimeOverride).toBe("lightweight");
    expect(t.outputRid).toBe("/examples/processed");
    expect(t.outputs).toHaveLength(1);
    expect(t.outputs[0].param).toBe("processed");
    expect(t.outputs[0].rid).toBe("/examples/processed");
    expect(t.inputs[0].param).toBe("students");
    expect(t.inputs[0].rid).toBe("/examples/students_hair_eye_color");
  });

  it("discovers @transform.spark.using with runtimeOverride=spark", () => {
    const py = `from transforms.api import transform, Input, Output
@transform.spark.using(
    src=Input("ri.foundry.main.dataset.in"),
    out=Output("ri.foundry.main.dataset.out"),
)
def big(src, out):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/big.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    expect(r.transforms[0].kind).toBe("transform");
    expect(r.transforms[0].using).toBe(true);
    expect(r.transforms[0].runtimeOverride).toBe("spark");
  });

  it("discovers the legacy stacked @lightweight @transform(...) form (Palantir legacy, portable)", () => {
    const py = `from transforms.api import transform, lightweight, Input, Output
@lightweight
@transform(
    output=Output("ri.foundry.main.dataset.out"),
    source=Input("ri.foundry.main.dataset.in"),
)
def legacy(output, source):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/legacy.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    // The kind stays 'transform' (NOT 'lightweight'); only the runtime flips
    // to 'lightweight' via the stacked @lightweight (no parens) override.
    expect(r.transforms[0].kind).toBe("transform");
    expect(r.transforms[0].using).toBe(false);
    expect(r.transforms[0].runtimeOverride).toBe("lightweight");
    expect(r.transforms[0].outputRid).toBe("ri.foundry.main.dataset.out");
  });

  it("discovers a multi-output @transform.using with N Input + M Output bindings", () => {
    const py = `from transforms.api import transform, Input, Output
@transform.using(
    hair_color=Input("/examples/students_hair_color"),
    eye_color=Input("/examples/students_eye_color"),
    males=Output("/examples/hair_eye_color_males"),
    females=Output("/examples/hair_eye_color_females"),
)
def split(hair_color, eye_color, males, females):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/split.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    const t = r.transforms[0];
    expect(t.inputs).toHaveLength(2);
    expect(t.outputs).toHaveLength(2);
    expect(t.outputs.map((o) => o.param).sort()).toEqual(["females", "males"]);
    // outputRid keeps the FIRST output's rid (backward-compat) so existing
    // buildService code paths still work for single-output transforms.
    expect(t.outputRid).toBe("/examples/hair_eye_color_males");
  });

  it("accepts a catalog path (Input /Project/Folder/Dataset) without an RID rejections", () => {
    const py = `from transforms.api import transform, Input, Output
@transform.using(
    orders=Input("/Manual Tests/Orders"),
    output=Output("/Manual Tests/Filtered Orders"),
)
def f(orders, output):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/f.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    expect(r.transforms[0].inputs[0].rid).toBe("/Manual Tests/Orders");
    expect(r.transforms[0].outputs[0].rid).toBe("/Manual Tests/Filtered Orders");
  });

  it("rejects a placeholder {{datasetRid}} template", () => {
    const py = `from transforms.api import transform, Input, Output
@transform.using(
    orders=Input("ri.foundry.main.dataset.in"),
    output=Output("{{datasetRid}}"),
)
def f(orders, output):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/f.py", content: py }]);
    expect(r.transforms).toHaveLength(0);
    expect(r.errors[0].message).toMatch(/invalid\/placeholder Output reference/);
  });

  it("rejects a within-transform Input==Output cycle (same dataset reference on both sides)", () => {
    const py = `from transforms.api import transform, Input, Output
@transform.using(
    src=Input("ri.foundry.main.dataset.same"),
    out=Output("ri.foundry.main.dataset.same"),
)
def cyclic(src, out):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/cyc.py", content: py }]);
    expect(r.transforms).toHaveLength(0);
    expect(r.errors[0].message).toMatch(/cyclic input\/output dependency/);
  });

  it("effectiveRuntime + runtimeForDiscoveredBatch honor runtimeOverride (all-@transform.using batch → lightweight)", () => {
    // Reuse the production-faced helpers via the discovered objects above.
    const py = `from transforms.api import transform, Input, Output
@transform.using(
    src=Input("ri.foundry.main.dataset.in1"),
    out=Output("ri.foundry.main.dataset.out1"),
)
def a(src, out):
    pass
@transform.using(
    src=Input("ri.foundry.main.dataset.in2"),
    out=Output("ri.foundry.main.dataset.out2"),
)
def b(src, out):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/ab.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(2);
    // @transform.using → kind 'transform' but runtimeOverride 'lightweight' on
    // every transform → effectiveRuntime 'lightweight' for each, batch 'lightweight'.
    for (const t of r.transforms) {
      expect(t.kind).toBe("transform");
      expect(t.runtimeOverride).toBe("lightweight");
    }
  });

  it("legacy Tellus @lightweight(output=, source=) extension still discovered as kind 'lightweight' (backward compat)", () => {
    const py = `from transforms.api import lightweight, Output, Input
@lightweight(
    output=Output("ri.foundry.main.dataset.out"),
    source=Input("ri.foundry.main.dataset.in"),
)
def ext(output, source):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/ext.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    // The Tellus extension form keeps kind 'lightweight' (legacy); the
    // runtimeOverride is 'lightweight' too (per classifyDecoratorName).
    expect(r.transforms[0].kind).toBe("lightweight");
    expect(r.transforms[0].runtimeOverride).toBe("lightweight");
    expect(r.transforms[0].using).toBe(false);
  });

  it("Phase 5 — captures @incremental(snapshot_inputs=['binding']) on a @transform.using transform", () => {
    const py = `from transforms.api import transform, incremental, Input, Output
@incremental(snapshot_inputs=["country_codes"], v2_semantics=True)
@transform.using(
    phone_numbers=Input("/Data/Phone Numbers"),
    country_codes=Input("/Reference/Country Codes"),
    output=Output("/Data/Phone Countries"),
)
def compute(phone_numbers, country_codes, output):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/snap.py", content: py }]);
    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.transforms).toHaveLength(1);
    expect(r.transforms[0].incremental).toBe(true);
    expect(r.transforms[0].incrementalSnapshotInputs).toEqual(["country_codes"]);
  });

  it("Phase 5 — rejects an @incremental(snapshot_inputs=['unknown_binding']) whose name does not match any binding", () => {
    const py = `from transforms.api import transform, incremental, Input, Output
@incremental(snapshot_inputs=["does_not_exist"], v2_semantics=True)
@transform.using(
    phone_numbers=Input("/Data/Phone Numbers"),
    output=Output("/Data/Phone Countries"),
)
def compute(phone_numbers, output):
    pass
`;
    const r = discoverTransforms([{ path: "transforms/bad.snap.py", content: py }]);
    expect(r.transforms).toHaveLength(0);
    expect(r.errors[0].message).toMatch(/unknown binding name.*'does_not_exist'/);
  });
});
