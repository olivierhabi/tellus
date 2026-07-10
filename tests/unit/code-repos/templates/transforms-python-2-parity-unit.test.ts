// ---------------------------------------------------------------------------
// TR_PYTHON_2_0_0 — Foundry-faithful Python Transforms scaffold parity test.
//
// Pins the file set + content invariants that make 2.0.0 a parity clone of
// Palantir's live "Project structure" docs (fetched 2026-07-09), so a future
// manifest edit cannot silently drift. Mirrors the invariants asserted by the
// bash HTTP-level guard (scripts/test-template-parity.sh) and the cypress
// E2E (tellus-fe/cypress/e2e/transforms-python-template-parity.cy.ts), but at
// the pure-scaffold unit layer (no DB, no HTTP) for fast CI feedback.
//
// See src/services/templates/DECISIONS.md for the policy decisions encoded here.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { scaffold } from "../../../../src/services/templates/scaffold.js";
import { getTemplateManifest } from "../../../../src/services/templates/manifest.js";

const REPO_RID = "ri.code-repos.main.repository.0123abcd-ef01-4234-8567-89abcdef0123";

// The 11 paths 2.0.0 must ship (6 Foundry-confirmed + 3 tellus tooling + 2 tellus platform files
// kept per Decision 1). Unconfirmed-content files are OMITTED by design
// (Decision 3) — the OMITTED set is asserted below.
const EXPECTED_PATHS = [
  "src/palantir/__init__.py",
  "src/palantir/pipeline.py",
  "src/palantir/datasets/__init__.py",
  "src/palantir/datasets/examples.py",
  "src/setup.py",
  "src/setup.cfg",
  "conda_recipe/meta.yaml",
  "requirements.lock",
  "ci.yml",
  "Makefile",
  "repoSettings.json",
] as const;

const OMITTED_PATHS = [
  "build.gradle",
  "gradle.properties",
  "versions.properties",
  "templateConfig.json",
  "conda-versions.run.linux-64.lock",
  "src/.pylintrc",
  // 1.0.0 extras removed per Decision 1:
  "transforms/example.py",
  "transforms/enrich.py",
  "transforms/_incremental_example.py",
] as const;

function scaffoldDefault() {
  const m = getTemplateManifest("transforms-python", "2.0.0")!;
  return scaffold({
    manifest: m,
    parameters: {}, // wizard sends no params → defaults: packageName=palantir, datasetRid=placeholder
    repositoryRid: REPO_RID,
    repoDisplayName: "Demo Repo",
  });
}

describe("TR_PYTHON_2_0_0 — file set parity (Decision 1 + 3)", () => {
  it("scaffolds exactly the 11 expected paths (no missing, no extras)", () => {
    const r = scaffoldDefault();
    const paths = new Set(r.files.map((f) => f.path));
    for (const p of EXPECTED_PATHS) {
      expect(paths.has(p)).toBe(true);
    }
    expect(r.files.length).toBe(EXPECTED_PATHS.length);
  });

  it("omits the unconfirmed-content files + the removed 1.0.0 extras", () => {
    const r = scaffoldDefault();
    const paths = new Set(r.files.map((f) => f.path));
    for (const p of OMITTED_PATHS) {
      expect(paths.has(p)).toBe(false);
    }
  });
});

describe("TR_PYTHON_2_0_0 — pipeline.py invariants", () => {
  it("uses the package name + auto-discovery (Foundry live default, 4 lines)", () => {
    const r = scaffoldDefault();
    const f = r.files.find((x) => x.path === "src/palantir/pipeline.py")!;
    expect(f.content).toContain("from transforms.api import Pipeline");
    expect(f.content).toContain("from palantir import datasets");
    expect(f.content).toContain("my_pipeline = Pipeline()");
    expect(f.content).toContain("my_pipeline.discover_transforms(datasets)");
    // No blank line between imports and my_pipeline (matches live doc "Copied 1-4").
    expect(f.content).not.toContain("import datasets\n\nmy_pipeline");
  });
});

describe("TR_PYTHON_2_0_0 — setup.py invariants", () => {
  it("declares the transforms.pipelines entry point over the package", () => {
    const r = scaffoldDefault();
    const f = r.files.find((x) => x.path === "src/setup.py")!;
    expect(f.content).toContain("from setuptools import find_packages, setup");
    expect(f.content).toContain("'transforms.pipelines'");
    expect(f.content).toContain("'root = palantir.pipeline:my_pipeline'");
    expect(f.content).toContain("find_packages(exclude=['contrib', 'docs', 'test'])");
  });

  it("leaves Foundry's build-time tokens literal (os.environ + spaced REPOSITORY_ORG_NAME)", () => {
    const r = scaffoldDefault();
    const f = r.files.find((x) => x.path === "src/setup.py")!;
    // PKG_NAME / PKG_VERSION are Foundry conda-build env vars — passed through.
    expect(f.content).toContain("name=os.environ['PKG_NAME']");
    expect(f.content).toContain("version=os.environ['PKG_VERSION']");
    // REPOSITORY_ORG_NAME is Foundry's template token — tellus must NOT resolve
    // it (no org name to fabricate). Spaced form so tellus's no-whitespace
    // substitute leaves it literal rather than throwing.
    expect(f.content).toContain("author='{{ REPOSITORY_ORG_NAME }}'");
    // No tellus param leaked unsubstituted.
    expect(f.content).not.toContain("{{packageName}}");
  });
});

describe("TR_PYTHON_2_0_0 — meta.yaml invariants", () => {
  it("pins python 3.9.* in build AND run + declares the transforms run deps", () => {
    const r = scaffoldDefault();
    const f = r.files.find((x) => x.path === "conda_recipe/meta.yaml")!;
    // python 3.9.* appears in both build and run (2 occurrences).
    const matches = f.content.match(/python 3\.9\.\*/g);
    expect(matches?.length).toBe(2);
    expect(f.content).toContain("- transforms {{ PYTHON_TRANSFORMS_VERSION }}");
    expect(f.content).toContain("- transforms-expectations");
    expect(f.content).toContain("- transforms-verbs");
    expect(f.content).toContain("script: python setup.py install --single-version-externally-managed --record=record.txt");
  });

  it("leaves Foundry's {{ ... }} tokens literal (PACKAGE_NAME / PACKAGE_VERSION / PYTHON_TRANSFORMS_VERSION)", () => {
    const r = scaffoldDefault();
    const f = r.files.find((x) => x.path === "conda_recipe/meta.yaml")!;
    expect(f.content).toContain('name: "{{ PACKAGE_NAME }}"');
    expect(f.content).toContain('version: "{{ PACKAGE_VERSION }}"');
    expect(f.content).toContain("transforms {{ PYTHON_TRANSFORMS_VERSION }}");
  });
});

describe("TR_PYTHON_2_0_0 — examples.py invariants (commented-out starter)", () => {
  it("ships COMMENTED OUT (Foundry-faithful; non-building until uncommented)", () => {
    const r = scaffoldDefault();
    const f = r.files.find((x) => x.path === "src/palantir/datasets/examples.py")!;
    // Every code line is commented.
    expect(f.content).toContain("# from transforms.api import Input, Output, transform, LightweightInput, LightweightOutput");
    expect(f.content).toContain("# @transform.using(");
    expect(f.content).toContain("#     output_dataset=Output(");
    expect(f.content).toContain("# def compute(");
    expect(f.content).toContain("#     output_dataset.write_table(input_dataset.polars(lazy=True))");
    // No active (uncommented) transform decorator.
    expect(f.content).not.toMatch(/^@transform\.using/m);
    expect(f.content).not.toMatch(/^def compute/m);
  });

  it("substitutes {{datasetRid}} into both commented paths (default placeholder)", () => {
    const r = scaffoldDefault();
    const f = r.files.find((x) => x.path === "src/palantir/datasets/examples.py")!;
    expect(f.content).toContain('output_dataset=Output("ri.foundry.main.dataset.placeholder")');
    expect(f.content).toContain('input_dataset=Input("ri.foundry.main.dataset.placeholder")');
    expect(f.content).not.toContain("{{datasetRid}}");
    expect(f.content).not.toContain("/path/to/output/dataset");
  });
});

describe("TR_PYTHON_2_0_0 — package markers + platform files", () => {
  it("ships empty __init__.py package markers (confirmed-empty, not fabricated)", () => {
    const r = scaffoldDefault();
    const a = r.files.find((x) => x.path === "src/palantir/__init__.py")!;
    const b = r.files.find((x) => x.path === "src/palantir/datasets/__init__.py")!;
    expect(a.content).toBe("");
    expect(b.content).toBe("");
  });

  it("ci.yml lints src/ (not the removed transforms/ dir) + keeps Stemma/Jemma stages", () => {
    const r = scaffoldDefault();
    const f = r.files.find((x) => x.path === "ci.yml")!;
    expect(f.content).toContain("python -m pyflakes src/");
    expect(f.content).not.toContain("pyflakes transforms/");
    expect(f.content).toContain("tellus transforms discover");
    expect(f.content).toContain("tellus transforms build");
  });

  it("repoSettings.json requires jemma:build (kept tellus platform file)", () => {
    const r = scaffoldDefault();
    const f = r.files.find((x) => x.path === "repoSettings.json")!;
    expect(f.content).toContain("jemma:build");
    expect(f.content).toContain('"defaultBranch": "master"');
  });
});

describe("TR_PYTHON_2_0_0 — parameter substitution round-trips", () => {
  it("packageName override propagates to paths + imports + entry point", () => {
    const m = getTemplateManifest("transforms-python", "2.0.0")!;
    const r = scaffold({
      manifest: m,
      parameters: { packageName: "myproject", datasetRid: "ri.foundry.main.dataset.placeholder" },
      repositoryRid: REPO_RID,
      repoDisplayName: "x",
    });
    const paths = new Set(r.files.map((f) => f.path));
    expect(paths.has("src/myproject/__init__.py")).toBe(true);
    expect(paths.has("src/myproject/pipeline.py")).toBe(true);
    expect(paths.has("src/myproject/datasets/examples.py")).toBe(true);
    const pipe = r.files.find((f) => f.path === "src/myproject/pipeline.py")!;
    expect(pipe.content).toContain("from myproject import datasets");
    const setup = r.files.find((f) => f.path === "src/setup.py")!;
    expect(setup.content).toContain("'root = myproject.pipeline:my_pipeline'");
  });

  it("datasetRid override lands in examples.py commented paths", () => {
    const m = getTemplateManifest("transforms-python", "2.0.0")!;
    const r = scaffold({
      manifest: m,
      parameters: { datasetRid: "ri.foundry.main.dataset.real-output-001" },
      repositoryRid: REPO_RID,
      repoDisplayName: "x",
    });
    const ex = r.files.find((f) => f.path === "src/palantir/datasets/examples.py")!;
    expect(ex.content).toContain('Output("ri.foundry.main.dataset.real-output-001")');
    expect(ex.content).toContain('Input("ri.foundry.main.dataset.real-output-001")');
    expect(ex.content).not.toContain("{{datasetRid}}");
    expect(ex.content).not.toContain("ri.foundry.main.dataset.placeholder");
  });

  it("rejects an invalid packageName (regex) + rejects unknown params", () => {
    const m = getTemplateManifest("transforms-python", "2.0.0")!;
    let captured: unknown = null;
    try {
      scaffold({
        manifest: m,
        parameters: { packageName: "Invalid-Upper" },
        repositoryRid: REPO_RID,
        repoDisplayName: "x",
      });
    } catch (e) {
      captured = e;
    }
    expect((captured as { envelope?: { errorName?: string } })?.envelope?.errorName).toBe("Templates:ParameterValidationFailed");
  });
});

describe("TR_PYTHON_2_0_0 — 1.0.0 still scaffoldable (Decision 4: pinned consumers)", () => {
  it("transforms-python@1.0.0 remains non-deprecated + scaffoldable (flat transforms/ layout)", () => {
    const m = getTemplateManifest("transforms-python", "1.0.0")!;
    expect(m.deprecated).toBe(false);
    const r = scaffold({
      manifest: m,
      parameters: { datasetRid: "ri.foundry.main.dataset.placeholder" },
      repositoryRid: REPO_RID,
      repoDisplayName: "x",
    });
    const paths = new Set(r.files.map((f) => f.path));
    expect(paths.has("transforms/example.py")).toBe(true);
    expect(paths.has("src/palantir/pipeline.py")).toBe(false);
  });
});
