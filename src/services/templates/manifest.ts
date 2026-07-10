// B3 — Template manifest types + v1 catalog.
//
// Templates are TS literals shipped with the service binary. Files are templated
// via {{paramName}} placeholders; binary files are base64-encoded.

export interface TemplateParameter {
  readonly name: string;
  readonly regex: string;
  readonly default?: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface TemplateFile {
  readonly path: string;
  readonly content: string;          // utf8 source or base64-encoded binary
  readonly mode: "100644" | "100755";
  readonly isBinary: boolean;
}

export interface TemplateManifest {
  readonly templateId: string;
  readonly version: string;
  readonly displayName: string;
  readonly language: "typescript" | "python" | "java" | "sql";
  readonly category: "functions" | "transforms";
  readonly description: string;
  readonly parameters: ReadonlyArray<TemplateParameter>;
  readonly files: ReadonlyArray<TemplateFile>;
  readonly deprecated: boolean;
}

// ---------------------------------------------------------------------------
// TS_FUNCTIONS_2_4_0 — Foundry-faithful v2 TypeScript Functions scaffold.
//
// Identity invariant: the language subproject lives at `typescript-functions/`
// (this directory name is the v2 discriminator; v1 used `functions-typescript/`
// and the function-discovery walker keys off this prefix). The outer
// scaffold is the generic Gradle multi-project wrapper that all Foundry
// repos share even when the language subproject is pure Node.
//
// The ≈22-file Foundry scaffold ships three binary artifacts that this
// manifest deliberately omits for the in-process catalog:
//   - `gradle/wrapper/gradle-wrapper.jar` (binary)
//   - `gradlew`, `gradlew.bat` (executable mode)
// They are bundled into the production template-repo (B3 reads from a
// system Stemma repo per the v2 spec) but the in-memory catalog stays
// pure-text so its file list is human-reviewable in source.
//
// File-discovery contract for B8 Functions Registry (per the v2 spec the
// scaffold targets):
//   - `typescript-functions/src/functions/<name>.ts`
//   - `export default` (default export = "publish")
//   - File path == function ID; the AST walker reads filenames, not
//     metadata.
// ---------------------------------------------------------------------------
const TS_FUNCTIONS_2_4_0: TemplateManifest = {
  templateId: "typescript-functions",
  version: "2.4.0",
  displayName: "TypeScript Functions",
  language: "typescript",
  category: "functions",
  description: "Functions on Objects in TypeScript with @Function decorators.",
  parameters: [
    {
      name: "packageName",
      regex: "^[a-z][a-z0-9-]{0,63}$",
      default: "<derived from repo name>",
      description: "npm package name (lowercase, hyphens only).",
    },
  ],
  deprecated: false,
  files: [
    // -----------------------------------------------------------------------
    // Root-level files (Gradle wrapper, CI, repo-level metadata).
    // -----------------------------------------------------------------------
    {
      path: "templateConfig.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "parentTemplateId": "typescript-functions",
  "parentTemplateVersion": "2.4.0"
}
`,
    },
    // README.md intentionally omitted — Tellus surfaces template intent
    // through the Code Repositories landing + per-template manifest pages,
    // not a per-repo markdown file. Foundry repos don't ship a generic
    // README either; metadata lives in templateConfig.json.
    {
      path: ".gitignore",
      mode: "100644",
      isBinary: false,
      content: `# Node
node_modules/
dist/
*.tsbuildinfo

# Foundry-internal codegen output (regenerated from resources.json)
**/.osdk-generated/

# Gradle
.gradle/
build/

# Logs / scratch
*.log
.DS_Store
`,
    },
    {
      path: ".gitattributes",
      mode: "100644",
      isBinary: false,
      content: `* text=auto eol=lf
*.jar binary
gradlew text eol=lf
gradlew.bat text eol=crlf
`,
    },
    {
      path: "ci.yml",
      mode: "100644",
      isBinary: false,
      content: `# Stemma/Jemma CI pipeline for typescript-functions@2.4.0.
# Stages run in order; later stages depend on the artifacts of earlier
# ones via the Gradle build cache.
version: 1
stages:
  - id: install
    command: ./gradlew :typescript-functions:npmInstall
  - id: type-check
    command: ./gradlew :typescript-functions:typeCheck
    needs: [install]
  - id: lint
    command: ./gradlew :typescript-functions:lint
    needs: [install]
  - id: build
    command: ./gradlew :typescript-functions:build
    needs: [type-check, lint]
  - id: test
    command: ./gradlew :typescript-functions:test
    needs: [build]
  - id: publish
    command: ./gradlew :typescript-functions:publishFunctions
    needs: [test]
    only:
      tags: 'v*'
`,
    },
    {
      path: "build.gradle",
      mode: "100644",
      isBinary: false,
      content: `// Root multi-project build. All language work happens in subprojects.
allprojects {
    group = '{{packageName}}'
    version = project.findProperty('repoVersion') ?: '0.0.0'
}
`,
    },
    {
      path: "settings.gradle",
      mode: "100644",
      isBinary: false,
      content: `rootProject.name = '{{packageName}}'
include ':typescript-functions'
`,
    },
    {
      path: "gradle.properties",
      mode: "100644",
      isBinary: false,
      content: `# Foundry template metadata — read by the upgrade system.
templateId=typescript-functions
templateVersion=2.4.0

# Toolchain pins (mirror the Foundry v2 runtime).
nodeVersion=20.11.1
typescriptVersion=5.4.0

# Build flags.
org.gradle.parallel=true
org.gradle.caching=true
`,
    },
    {
      path: "gradle/wrapper/gradle-wrapper.properties",
      mode: "100644",
      isBinary: false,
      content: `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.6-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`,
    },
    {
      path: "repoSettings.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "defaultBranch": "main",
  "branchProtection": [
    {
      "branchPattern": "main",
      "requirePullRequest": true,
      "requiredApprovers": 1,
      "requiredStatusChecks": ["jemma:build", "jemma:test"]
    }
  ],
  "tagNameValidation": {
    "regex": "^v?(0|[1-9]\\\\d*)\\\\.(0|[1-9]\\\\d*)\\\\.(0|[1-9]\\\\d*)(-[0-9A-Za-z.-]+)?$",
    "description": "Semver 2.0.0 (with optional leading v)."
  }
}
`,
    },
    // -----------------------------------------------------------------------
    // typescript-functions/ subproject (the V2 discriminator).
    // -----------------------------------------------------------------------
    {
      path: "typescript-functions/build.gradle",
      mode: "100644",
      isBinary: false,
      content: `// TypeScript Functions subproject.
// Wraps npm/tsc/vitest as Gradle tasks so Jemma's CI driver can invoke
// them uniformly across language subprojects.

task npmInstall(type: Exec) {
    commandLine 'npm', 'ci'
}

task typeCheck(type: Exec) {
    dependsOn npmInstall
    commandLine 'npx', 'tsc', '--noEmit'
}

task lint(type: Exec) {
    dependsOn npmInstall
    commandLine 'npx', 'eslint', 'src', '--max-warnings', '0'
    ignoreExitValue = false
}

task build(type: Exec) {
    dependsOn typeCheck
    commandLine 'npx', 'tsc'
}

task test(type: Exec) {
    dependsOn build
    commandLine 'npx', 'vitest', 'run'
}

task publishFunctions(type: Exec) {
    dependsOn test
    commandLine 'npx', '@osdk/functions', 'publish'
}

defaultTasks 'build'
`,
    },
    {
      path: "typescript-functions/package.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "name": "{{packageName}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "eslint src --max-warnings 0"
  },
  "dependencies": {
    "@osdk/client": "^2.0.0",
    "@osdk/functions": "^2.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "eslint": "^8.57.0"
  }
}
`,
    },
    {
      path: "typescript-functions/tsconfig.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"]
}
`,
    },
    {
      path: "typescript-functions/functions.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "enableExternalSystems": false,
  "enableModelFunctions": false,
  "enableOntologyEditFunctions": true,
  "enableQueryFunctions": true
}
`,
    },
    {
      path: "typescript-functions/resources.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "imports": []
}
`,
    },
    {
      path: "typescript-functions/.npmrc",
      mode: "100644",
      isBinary: false,
      content: `# Resolve @osdk/* from the Foundry-internal artifactory mirror.
# Replace with your registry URL in non-Foundry environments.
@osdk:registry=https://artifactory.foundry.local/artifactory/api/npm/npm-virtual/
registry=https://registry.npmjs.org/
save-exact=true
`,
    },
    {
      path: "typescript-functions/src/functions/helloWorld.ts",
      mode: "100644",
      isBinary: false,
      content: `// One function per file. The basename of this file (\`helloWorld\`) is
// the function's identity in the Functions Registry; renaming the file
// renames the function. The \`export default\` is what makes Jemma's
// AST walker pick this up at build time.

export default function helloWorld(name: string): string {
  return \`Hello, \${name}\`;
}
`,
    },
    {
      path: "typescript-functions/test/.gitkeep",
      mode: "100644",
      isBinary: false,
      content: "",
    },
  ],
};

const PY_FUNCTIONS_1_0_0: TemplateManifest = {
  templateId: "python-functions",
  version: "1.0.0",
  displayName: "Python Functions",
  language: "python",
  category: "functions",
  description: "Functions on Objects in Python with @function decorators.",
  parameters: [
    {
      name: "packageName",
      regex: "^[a-z][a-z0-9_]{0,63}$",
      default: "<derived from repo name>",
      description: "Python package name (lowercase + underscores).",
    },
  ],
  deprecated: false,
  files: [
    {
      path: "pyproject.toml",
      mode: "100644",
      isBinary: false,
      content: `[tool.poetry]
name = "{{packageName}}"
version = "0.1.0"
description = ""
authors = []

[tool.poetry.dependencies]
python = "^3.11"
`,
    },
    {
      path: "src/{{packageName}}/__init__.py",
      mode: "100644",
      isBinary: false,
      content: `from osdk import function

@function
def hello(name: str) -> str:
    return f"Hello, {name}"
`,
    },
    { path: "tests/__init__.py", mode: "100644", isBinary: false, content: "" },
    {
      path: "osdk.config.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "outputDir": ".osdk-generated",
  "imports": []
}
`,
    },
    {
      path: "repoSettings.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "defaultBranch": "main",
  "branchProtection": []
}
`,
    },
  ],
};

const TR_PYTHON_1_0_0: TemplateManifest = {
  templateId: "transforms-python",
  version: "1.0.0",
  displayName: "Python Transforms",
  language: "python",
  category: "transforms",
  description: "Datasets transformed by @transform-decorated Python.",
  parameters: [
    {
      name: "datasetRid",
      regex: "^ri\\.[a-z][a-z0-9_-]{0,127}\\.[a-z][a-z0-9_-]{0,127}\\.[a-z][a-z0-9_-]{0,127}\\.[a-zA-Z0-9_-]{1,128}$",
      default: "ri.foundry.main.dataset.placeholder",
      description: "Output dataset RID for the example seed transform. Edit per repo.",
      required: true,
    },
  ],
  deprecated: false,
  files: [
    {
      // A self-contained source transform: no inputs, so a freshly-created
      // repo builds GREEN immediately ("Build" -> materialized output dataset).
      path: "transforms/example.py",
      mode: "100644",
      isBinary: false,
      content: `from transforms.api import transform, Output, DataFrame

# A source transform: it has no inputs and synthesizes a small seed dataset,
# so a brand-new repo builds successfully out of the box. Replace the rows (or
# add an Input(...)) with your real logic.
#
# To read an existing dataset instead, declare an input:
#
#     @transform(
#         output=Output("{{datasetRid}}"),
#         orders=Input("ri.foundry.main.dataset.<your-input>"),
#     )
#     def example_transform(output, orders):
#         output.write_dataframe(orders.dataframe().filter(lambda r: r["amount"] > 0))


@transform(output=Output("{{datasetRid}}"))
def example_seed(output):
    output.write_dataframe(
        DataFrame(
            [
                {"id": 1, "category": "a", "value": 10},
                {"id": 2, "category": "b", "value": 20},
                {"id": 3, "category": "a", "value": 30},
            ]
        )
    )
`,
    },
    {
      // A second transform that READS the seed output and writes an enriched
      // dataset — demonstrates Input/Output dataset lineage + @transform_df.
      path: "transforms/enrich.py",
      mode: "100644",
      isBinary: false,
      content: `from transforms.api import transform_df, Output, Input


@transform_df(
    Output("{{datasetRid}}-enriched"),
    seed=Input("{{datasetRid}}"),
)
def enrich(seed):
    # @transform_df: return the output DataFrame (it is written automatically).
    df = seed.dataframe()
    return df.with_column("value_x2", lambda r: int(r["value"]) * 2)
`,
    },
    {
      // An @incremental example (snapshot vs append write semantics). Disabled
      // by default (rename to .py / remove the leading underscore to enable).
      path: "transforms/_incremental_example.py",
      mode: "100644",
      isBinary: false,
      content: `from transforms.api import transform, incremental, Output, Input


# @incremental tells the build to APPEND (vs SNAPSHOT-replace) the output.
@incremental()
@transform(
    output=Output("{{datasetRid}}-events"),
    source=Input("{{datasetRid}}"),
)
def append_events(output, source):
    output.write_dataframe(source.dataframe(), mode="modify")
`,
    },
    {
      path: "ci.yml",
      mode: "100644",
      isBinary: false,
      content: `# Stemma/Jemma CI pipeline for transforms-python.
stages:
  - name: lint
    command: python -m pyflakes transforms/
  - name: discover
    command: tellus transforms discover
  - name: build
    command: tellus transforms build
  - name: test
    command: python -m pytest -q
`,
    },
    {
      path: "repoSettings.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "defaultBranch": "master",
  "tagNameValidation": "semver",
  "branchProtection": [
    { "branch": "master", "requiredStatusChecks": ["jemma:build"] }
  ]
}
`,
    },
  ],
};

// ---------------------------------------------------------------------------
// TR_PYTHON_2_0_0 — Foundry-faithful Python Transforms scaffold (parity with
// Palantir's live "Project structure" docs, fetched 2026-07-09).
//
// Replaces the 1.0.0 flat `transforms/` layout with Foundry's nested
// `src/<package>/` package layout + `pipeline.py` auto-discovery +
// `setup.py` `transforms.pipelines` entry point + `conda_recipe/meta.yaml`.
// See DECISIONS.md (next to this file) for the four policy decisions
// (extra-file survival, package name, unconfirmed-file handling, version bump).
//
// Deviations from Foundry's literal default (all user-directed or guardrail-
// driven; documented in DECISIONS.md):
//   - package name defaults to `palantir` (Foundry literal: `myproject`).
//   - `examples.py` ships commented-out (Foundry-faithful) BUT with both
//     dataset paths substituted from `{{datasetRid}}` (tellus extension per
//     brief §4) — so a fresh repo does NOT build green until uncommented.
//   - `{{REPOSITORY_ORG_NAME}}` in setup.py is spaced (`{{ REPOSITORY_ORG_NAME }}`)
//     so tellus's no-whitespace substitute leaves Foundry's build token literal.
//   - Unconfirmed-content files (build.gradle inner+outer, gradle.properties,
//     versions.properties, templateConfig.json, conda-versions lock, .pylintrc)
//     are OMITTED — tracked follow-ups. (setup.cfg IS shipped — see "Ship tellus
//     tooling" in DECISIONS.md §3; only Foundry's body is UNVERIFIED.)
// ---------------------------------------------------------------------------
const TR_PYTHON_2_0_0: TemplateManifest = {
  templateId: "transforms-python",
  version: "2.0.0",
  displayName: "Python Transforms",
  language: "python",
  category: "transforms",
  description: "Datasets transformed by @transform-decorated Python (Foundry-faithful layout).",
  parameters: [
    {
      name: "packageName",
      regex: "^[a-z][a-z0-9_]{0,63}$",
      default: "palantir",
      description: "Python package name (Foundry literal default is 'myproject'; tellus default is 'palantir' per user direction).",
    },
    {
      name: "datasetRid",
      regex: "^ri\\.[a-z][a-z0-9_-]{0,127}\\.[a-z][a-z0-9_-]{0,127}\\.[a-z][a-z0-9_-]{0,127}\\.[a-zA-Z0-9_-]{1,128}$",
      default: "ri.foundry.main.dataset.placeholder",
      description: "Dataset RID substituted into the commented examples.py starter paths.",
      required: true,
    },
  ],
  deprecated: false,
  files: [
    // --- Foundry visible tree (src/<package>/ + conda_recipe/) ------------
    {
      // Empty package marker (content unconfirmed — ship empty, don't guess).
      path: "src/{{packageName}}/__init__.py",
      mode: "100644",
      isBinary: false,
      content: "",
    },
    {
      // Foundry live default (4 lines, no blank line between imports and
      // my_pipeline — matches the live doc's "Copied 1-4" widget).
      path: "src/{{packageName}}/pipeline.py",
      mode: "100644",
      isBinary: false,
      content: `from transforms.api import Pipeline
from {{packageName}} import datasets
my_pipeline = Pipeline()
my_pipeline.discover_transforms(datasets)
`,
    },
    {
      // Empty package marker (content unconfirmed — ship empty, don't guess).
      path: "src/{{packageName}}/datasets/__init__.py",
      mode: "100644",
      isBinary: false,
      content: "",
    },
    {
      // Foundry default ships COMMENTED OUT ("an uncommented version of the
      // default"). Per brief §4, both dataset paths are substituted from
      // {{datasetRid}} (tellus extension; commented-out so non-executing).
      path: "src/{{packageName}}/datasets/examples.py",
      mode: "100644",
      isBinary: false,
      content: `# from transforms.api import Input, Output, transform, LightweightInput, LightweightOutput
#
#
# @transform.using(
#     output_dataset=Output("{{datasetRid}}"),
#     input_dataset=Input("{{datasetRid}}"),
# )
# def compute(input_dataset: LightweightInput, output_dataset: LightweightOutput) -> None:
#     output_dataset.write_table(input_dataset.polars(lazy=True))
`,
    },
    {
      // Foundry live default (23 lines). `{{ REPOSITORY_ORG_NAME }}` is spaced
      // so tellus leaves Foundry's build-time token literal (cosmetic; see
      // DECISIONS.md §3). os.environ['PKG_NAME']/['PKG_VERSION'] are Foundry
      // conda-build env vars, passed through untouched.
      path: "src/setup.py",
      mode: "100644",
      isBinary: false,
      content: `import os
from setuptools import find_packages, setup

setup(
    name=os.environ['PKG_NAME'],
    version=os.environ['PKG_VERSION'],

    description='Python data transformation project',

    # Modify the author for this project
    author='{{ REPOSITORY_ORG_NAME }}',

    packages=find_packages(exclude=['contrib', 'docs', 'test']),

    # Instead, specify your dependencies in conda_recipe/meta.yml
    install_requires=[],

    entry_points={
        'transforms.pipelines': [
            'root = {{packageName}}.pipeline:my_pipeline'
        ]
    }
)
`,
    },
    {
      // Foundry live default (30 lines). All {{ ... }} tokens are Foundry's
      // (PACKAGE_NAME / PACKAGE_VERSION / PYTHON_TRANSFORMS_VERSION) — spaced,
      // so tellus leaves them literal for Foundry to resolve. python 3.9.*
      // pinned in build AND run.
      path: "conda_recipe/meta.yaml",
      mode: "100644",
      isBinary: false,
      content: `# If you need to modify the runtime requirements for your package,
# update the 'requirements.run' section in this file

package:
  name: "{{ PACKAGE_NAME }}"
  version: "{{ PACKAGE_VERSION }}"

source:
  path: ../src

requirements:
  # Tools required to build the package. These packages are run on the build system and include
  # things such as revision control systems (Git, SVN) make tools (GNU make, Autotool, CMake) and
  # compilers (real cross, pseudo-cross, or native when not cross-compiling), and any source pre-processors.
  # https://docs.conda.io/projects/conda-build/en/latest/resources/define-metadata.html#build
  build:
    - python 3.9.*
    - setuptools

  # Packages required to run the package. These are the dependencies that are installed automatically
  # whenever the package is installed.
  # https://docs.conda.io/projects/conda-build/en/latest/resources/define-metadata.html#run
  run:
    - python 3.9.*
    - transforms {{ PYTHON_TRANSFORMS_VERSION }}
    - transforms-expectations
    - transforms-verbs

build:
  script: python setup.py install --single-version-externally-managed --record=record.txt
`,
    },
    // --- tellus platform files (KEPT per Decision 1; outside Foundry domain) ---
    {
      // Stemma/Jemma CI for transforms-python. One consistency fix vs 1.0.0:
      // lint path transforms/ -> src/ (2.0.0 moves sources into src/<package>/).
      path: "ci.yml",
      mode: "100644",
      isBinary: false,
      content: `# Stemma/Jemma CI pipeline for transforms-python.
stages:
  - name: lint
    command: python -m pyflakes src/
  - name: discover
    command: tellus transforms discover
  - name: build
    command: tellus transforms build
  - name: test
    command: python -m pytest -q
`,
    },
    {
      path: "repoSettings.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "defaultBranch": "master",
  "tagNameValidation": "semver",
  "branchProtection": [
    { "branch": "master", "requiredStatusChecks": ["jemma:build"] }
  ]
}
`,
    },
    // --- build/tooling files (tellus-native; make a scaffolded repo complete) ---
    // The transforms.api library + tellus-transforms CLI are NOT committed here —
    // they are published as the `tellus-transforms` distribution (see
    // packages/transforms-python/) and declared as a dep in conda_recipe/meta.yaml +
    // resolved into requirements.lock. This mirrors Foundry, where `transforms` is a
    // conda dep, not committed into the repo.
    {
      // setup.cfg — Foundry ships this file but its default body is NOT documented
      // (UNVERIFIED — see DECISIONS.md §3). tellus ships its OWN OSS tool config
      // (pytest/pycodestyle/pylint), mapping Foundry's pep8/pylint Gradle plugins to
      // OSS tools; no Gradle, no com.palantir.* IDs.
      path: "src/setup.cfg",
      mode: "100644",
      isBinary: false,
      content: `# Source: https://www.palantir.com/docs/foundry/transforms-python/project-structure/
# (setup.cfg exists in the default Foundry tree; its DEFAULT CONTENTS are NOT documented):
#   # UNVERIFIED — no public doc source for Foundry's setup.cfg body, needs product decision
# tellus tool config, grounded in OSS docs (pytest / pycodestyle / pylint).
[tool:pytest]
testpaths = tests
python_files = test_*.py
python_functions = test_*

[pycodestyle]
max-line-length = 120
exclude = build,dist,.venv

[pylint]
disable =
    missing-module-docstring,
    missing-class-docstring,
    missing-function-docstring
max-line-length = 120
`,
    },
    {
      // requirements.lock — pip-tools lock resolving meta.yaml run-deps (replaces
      // Foundry's Hawk resolution; Hawk algorithm UNVERIFIED — original tellus design).
      path: "requirements.lock",
      mode: "100644",
      isBinary: false,
      content: `# Source: pip-tools https://pip-tools.readthedocs.io/ (pip-compile output).
# tellus resolves conda_recipe/meta.yaml requirements.run via pip-compile -> this lock,
# replacing Foundry's Hawk resolution (Hawk algorithm UNVERIFIED).
#   # original implementation, not a port
#
# Generated by: tellus-transforms lock   (do not edit by hand)
#   pip-compile --output-file requirements.lock conda_recipe/meta.yaml

tellus-transforms==0.1.0  # tellus transforms.api library + build CLI (provides 'transforms' import)
polars==0.20.*            # lightweight compute engine (Input.polars())
# pyspark, pandas, duckdb: pulled per @transform.spark.using / .pandas() / .duckdb() usage
`,
    },
    {
      // Makefile — convenience orchestration (replaces Foundry Gradle Checks;
      // original tellus design, not Gradle, no com.palantir.* IDs). Recipe lines use
      // real tabs (\t) so `make` parses them.
      path: "Makefile",
      mode: "100644",
      isBinary: false,
      content: `# Source: original tellus orchestration (replaces Foundry Gradle Checks).
#   # original implementation, not a port
.PHONY: discover check lint test build lock

discover:
\ttellus-transforms discover
lint:
\tpycodestyle src && pylint src
test:
\tpytest -q
build:
\tpython -m build
lock:
\ttellus-transforms lock
check: lint test build
`,
    },
  ],
};

const TR_JAVA_1_0_0: TemplateManifest = {
  templateId: "transforms-java",
  version: "1.0.0",
  displayName: "Java Transforms",
  language: "java",
  category: "transforms",
  description: "Datasets transformed by @Transform-annotated Java.",
  parameters: [],
  deprecated: false,
  files: [
    {
      path: "src/main/java/com/example/ExampleTransform.java",
      mode: "100644",
      isBinary: false,
      content: `package com.example;

import com.palantir.transforms.lang.java.api.Compute;
import com.palantir.transforms.lang.java.api.Input;
import com.palantir.transforms.lang.java.api.Output;
import com.palantir.transforms.lang.java.api.Transform;
import org.apache.spark.sql.Dataset;
import org.apache.spark.sql.Row;

public final class ExampleTransform {

  @Transform(
      output = @Output("ri.foundry.main.dataset.placeholder"),
      input = @Input("ri.foundry.main.dataset.source-placeholder"))
  @Compute
  public Dataset<Row> example(Dataset<Row> input) {
    return input.filter("value > 0");
  }
}
`,
    },
    {
      path: "build.gradle",
      mode: "100644",
      isBinary: false,
      content: `plugins {
  id 'java-library'
  id 'com.palantir.transforms.lang.java'
}

repositories { mavenCentral() }

dependencies {
  implementation 'com.palantir.transforms:transforms-java-api'
  implementation 'org.apache.spark:spark-sql_2.13'
}
`,
    },
    {
      path: "repoSettings.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "defaultBranch": "main",
  "branchProtection": []
}
`,
    },
  ],
};

const TR_SQL_1_0_0: TemplateManifest = {
  templateId: "transforms-sql",
  version: "1.0.0",
  displayName: "SQL Transforms",
  language: "sql",
  category: "transforms",
  description: "Datasets transformed by SQL queries.",
  parameters: [],
  deprecated: false,
  files: [
    {
      path: "transforms/example.sql",
      mode: "100644",
      isBinary: false,
      content: `-- transforms-sql: each file materializes one output dataset.
-- The output dataset is declared with @output; inputs are referenced by RID.
-- @output ri.foundry.main.dataset.placeholder
CREATE TABLE output AS
SELECT
    id,
    category,
    value
FROM "ri.foundry.main.dataset.source-placeholder"
WHERE value > 0;
`,
    },
    {
      path: "repoSettings.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "defaultBranch": "main",
  "branchProtection": []
}
`,
    },
  ],
};

const CATALOG: ReadonlyMap<string, ReadonlyMap<string, TemplateManifest>> = (() => {
  const all: TemplateManifest[] = [
    TS_FUNCTIONS_2_4_0,
    PY_FUNCTIONS_1_0_0,
    TR_PYTHON_1_0_0,
    TR_PYTHON_2_0_0,
    TR_JAVA_1_0_0,
    TR_SQL_1_0_0,
  ];
  const byId = new Map<string, Map<string, TemplateManifest>>();
  for (const m of all) {
    let v = byId.get(m.templateId);
    if (v === undefined) {
      v = new Map();
      byId.set(m.templateId, v);
    }
    v.set(m.version, m);
  }
  return byId;
})();

export function listTemplateManifests(): ReadonlyArray<TemplateManifest> {
  const out: TemplateManifest[] = [];
  for (const versions of CATALOG.values()) {
    for (const m of versions.values()) out.push(m);
  }
  return out;
}

export function getTemplateManifest(
  templateId: string,
  version: string,
): TemplateManifest | null {
  const versions = CATALOG.get(templateId);
  if (versions === undefined) return null;
  return versions.get(version) ?? null;
}

/**
 * Compare two semver-ish version strings (e.g. "1.0.0" vs "2.4.0"). Returns
 * >0 if a > b, 0 if equal, <0 if a < b. Non-numeric segments coerce to 0.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Latest (semver-max) manifest per templateId. Used by the GET /templates list
 * route so the picker shows one row per template at its newest version —
 * Foundry-faithful ("bootstrapped with the latest version") and required once a
 * template ships more than one version (transforms-python 1.0.0 + 2.0.0).
 * Pinned consumers still scaffold any version via getTemplateManifest + the
 * scaffold endpoint (non-deprecated versions are not rejected).
 */
export function listLatestTemplateManifests(): ReadonlyArray<TemplateManifest> {
  const latest = new Map<string, TemplateManifest>();
  for (const m of listTemplateManifests()) {
    const cur = latest.get(m.templateId);
    if (cur === undefined || compareSemver(m.version, cur.version) > 0) {
      latest.set(m.templateId, m);
    }
  }
  return Array.from(latest.values());
}
