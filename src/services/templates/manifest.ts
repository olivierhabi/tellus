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
    {
      path: "package.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "name": "{{packageName}}",
  "version": "0.1.0",
  "private": true,
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@osdk/client": "^2.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
`,
    },
    {
      path: "tsconfig.json",
      mode: "100644",
      isBinary: false,
      content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "declaration": true
  },
  "include": ["src/**/*"]
}
`,
    },
    {
      path: "src/index.ts",
      mode: "100644",
      isBinary: false,
      content: `import { Function } from "@osdk/client";

/**
 * Example function. Replace with your own.
 *
 * @Function decorators are detected by Jemma at build time and become
 * callable functions on the platform.
 */
export class Example {
  @Function()
  static hello(name: string): string {
    return \`Hello, \${name}\`;
  }
}
`,
    },
    {
      path: ".gitignore",
      mode: "100644",
      isBinary: false,
      content: "node_modules/\ndist/\n.osdk-generated/\n*.log\n",
    },
    {
      path: "README.md",
      mode: "100644",
      isBinary: false,
      content: "# {{packageName}}\n\nGenerated from typescript-functions@2.4.0.\n",
    },
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
  "branchProtection": [
    {
      "branchPattern": "main",
      "requirePullRequest": true,
      "requiredApprovers": 1,
      "requiredStatusChecks": ["jemma:build", "jemma:test"]
    }
  ]
}
`,
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
