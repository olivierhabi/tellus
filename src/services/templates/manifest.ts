// B3 — Template manifest types + v1 catalog.
//
// Templates are TS literals shipped with the service binary. Files are templated
// via {{paramName}} placeholders; binary files are base64-encoded.

export interface TemplateParameter {
  readonly name: string;
  readonly regex: string;
  readonly default?: string;
  readonly description?: string;
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
      description: "Placeholder dataset RID for the example transform.",
    },
  ],
  deprecated: false,
  files: [
    {
      path: "transforms/example.py",
      mode: "100644",
      isBinary: false,
      content: `from transforms.api import transform, Output, Input

@transform(
    output=Output("{{datasetRid}}"),
    source=Input("ri.foundry.main.dataset.source-placeholder"),
)
def example_transform(output, source):
    output.write_dataframe(source.dataframe())
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

public class ExampleTransform {
  // Example. Replace with @Transform implementations.
}
`,
    },
    {
      path: "build.gradle",
      mode: "100644",
      isBinary: false,
      content: "plugins { id 'java' }\nrepositories { mavenCentral() }\n",
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
      content: "-- Example transform.\nSELECT 1 as placeholder;\n",
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
