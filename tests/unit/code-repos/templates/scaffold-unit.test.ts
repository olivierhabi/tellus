// B3 — scaffold engine unit tests.
//
// Coverage:
//  - Determinism: same inputs → same commitSha (idempotency premise)
//  - Different inputs → different commitSha
//  - Parameter substitution in content + path
//  - resolveParameters: missing required, unknown caller key, regex mismatch, default fallback
//  - Deprecated template throws Templates:VersionDeprecated
//  - File ordering doesn't affect commitSha (canonical sort)
//  - All 5 v1 templates can be scaffolded with their default parameters
//  - typescript-functions includes the spec-mandated 7 files

import { describe, it, expect } from "vitest";
import { scaffold, resolveParameters } from "../../../../src/services/templates/scaffold.js";
import {
  getTemplateManifest,
  listTemplateManifests,
  type TemplateManifest,
} from "../../../../src/services/templates/manifest.js";

const REPO_RID = "ri.code-repos.main.repository.0123abcd-ef01-4234-8567-89abcdef0123";

describe("scaffold — determinism (B3 acceptance §1)", () => {
  it("scaffolding same inputs twice produces identical commitSha", () => {
    const m = getTemplateManifest("typescript-functions", "2.4.0")!;
    const r1 = scaffold({ manifest: m, parameters: { packageName: "my-repo" }, repositoryRid: REPO_RID, repoDisplayName: "My Repo" });
    const r2 = scaffold({ manifest: m, parameters: { packageName: "my-repo" }, repositoryRid: REPO_RID, repoDisplayName: "My Repo" });
    expect(r1.commitSha).toBe(r2.commitSha);
    expect(r1.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("different repositoryRid → different commitSha (rid is part of canonical input)", () => {
    const m = getTemplateManifest("typescript-functions", "2.4.0")!;
    const r1 = scaffold({ manifest: m, parameters: {}, repositoryRid: REPO_RID, repoDisplayName: "X" });
    const r2 = scaffold({ manifest: m, parameters: {}, repositoryRid: REPO_RID + "X", repoDisplayName: "X" });
    expect(r1.commitSha).not.toBe(r2.commitSha);
  });

  it("different parameters → different commitSha", () => {
    const m = getTemplateManifest("typescript-functions", "2.4.0")!;
    const r1 = scaffold({ manifest: m, parameters: { packageName: "alpha" }, repositoryRid: REPO_RID, repoDisplayName: "x" });
    const r2 = scaffold({ manifest: m, parameters: { packageName: "beta" }, repositoryRid: REPO_RID, repoDisplayName: "x" });
    expect(r1.commitSha).not.toBe(r2.commitSha);
  });

  it("file content reflects parameter substitution", () => {
    const m = getTemplateManifest("typescript-functions", "2.4.0")!;
    const r = scaffold({ manifest: m, parameters: { packageName: "tellus-fns" }, repositoryRid: REPO_RID, repoDisplayName: "x" });
    const pkg = r.files.find((f) => f.path === "package.json");
    expect(pkg).toBeDefined();
    expect(pkg!.content).toContain('"name": "tellus-fns"');
    expect(pkg!.content).not.toContain("{{packageName}}");
  });

  it("file path reflects parameter substitution", () => {
    const m = getTemplateManifest("python-functions", "1.0.0")!;
    const r = scaffold({ manifest: m, parameters: { packageName: "my_pkg" }, repositoryRid: REPO_RID, repoDisplayName: "x" });
    const init = r.files.find((f) => f.path === "src/my_pkg/__init__.py");
    expect(init).toBeDefined();
  });
});

describe("resolveParameters", () => {
  const params = [
    { name: "packageName", regex: "^[a-z][a-z0-9-]{0,63}$", default: "<derived from repo name>" },
  ];

  it("returns caller-supplied value when valid", () => {
    expect(resolveParameters(params, { packageName: "my-repo" }, "anything")).toEqual({ packageName: "my-repo" });
  });

  it("derives from repo display name when default is the marker", () => {
    const r = resolveParameters(params, {}, "Hello World");
    expect(r.packageName).toBe("hello-world");
  });

  it("rejects regex mismatch with Templates:ParameterValidationFailed", () => {
    let captured: unknown = null; try { resolveParameters(params, { packageName: "INVALID UPPERCASE" }, "x"); } catch (e) { captured = e; } expect((captured as { envelope?: { errorName?: string } })?.envelope?.errorName).toBe("Templates:ParameterValidationFailed");
  });

  it("rejects unknown caller key with reason='unknown-parameter'", () => {
    let captured: unknown = null;
    try {
      resolveParameters(params, { packageName: "ok", junk: "v" }, "x");
    } catch (e) {
      captured = e;
    }
    expect(captured).not.toBeNull();
    const env = (captured as { envelope?: { parameters?: { reason?: string; parameterName?: string } } }).envelope;
    expect(env?.parameters?.reason).toBe("unknown-parameter");
    expect(env?.parameters?.parameterName).toBe("junk");
  });

  it("missing required (no default) throws", () => {
    const required = [{ name: "x", regex: "^[a-z]+$" }];
    let captured: unknown = null; try { resolveParameters(required, {}, "x"); } catch (e) { captured = e; } expect((captured as { envelope?: { errorName?: string } })?.envelope?.errorName).toBe("Templates:ParameterValidationFailed");
  });
});

describe("scaffold — deprecated template", () => {
  it("throws Templates:VersionDeprecated when manifest.deprecated=true", () => {
    const base = getTemplateManifest("typescript-functions", "2.4.0")!;
    const dep: TemplateManifest = { ...base, deprecated: true };
    let captured: unknown = null;
    try {
      scaffold({ manifest: dep, parameters: {}, repositoryRid: REPO_RID, repoDisplayName: "x" });
    } catch (e) {
      captured = e;
    }
    expect(captured).not.toBeNull();
    const env = (captured as { envelope?: { errorName?: string } }).envelope;
    expect(env?.errorName).toBe("Templates:VersionDeprecated");
  });
});

describe("scaffold — typescript-functions content invariants (spec line 376)", () => {
  it("includes the spec-mandated 7 files", () => {
    const m = getTemplateManifest("typescript-functions", "2.4.0")!;
    const r = scaffold({ manifest: m, parameters: { packageName: "demo" }, repositoryRid: REPO_RID, repoDisplayName: "Demo" });
    const paths = new Set(r.files.map((f) => f.path));
    expect(paths.has("package.json")).toBe(true);
    expect(paths.has("tsconfig.json")).toBe(true);
    expect(paths.has("src/index.ts")).toBe(true);
    expect(paths.has(".gitignore")).toBe(true);
    expect(paths.has("README.md")).toBe(true);
    expect(paths.has("osdk.config.json")).toBe(true);
    expect(paths.has("repoSettings.json")).toBe(true);
  });

  it("src/index.ts contains @Function() example", () => {
    const m = getTemplateManifest("typescript-functions", "2.4.0")!;
    const r = scaffold({ manifest: m, parameters: { packageName: "demo" }, repositoryRid: REPO_RID, repoDisplayName: "Demo" });
    const idx = r.files.find((f) => f.path === "src/index.ts");
    expect(idx?.content).toContain("@Function()");
  });

  it(".gitignore excludes .osdk-generated/", () => {
    const m = getTemplateManifest("typescript-functions", "2.4.0")!;
    const r = scaffold({ manifest: m, parameters: { packageName: "demo" }, repositoryRid: REPO_RID, repoDisplayName: "Demo" });
    const gi = r.files.find((f) => f.path === ".gitignore");
    expect(gi?.content).toContain(".osdk-generated/");
  });
});

describe("scaffold — all 5 v1 templates round-trip", () => {
  for (const m of listTemplateManifests()) {
    it(`scaffolds ${m.templateId}@${m.version}`, () => {
      const r = scaffold({ manifest: m, parameters: {}, repositoryRid: REPO_RID, repoDisplayName: "Demo Repo" });
      expect(r.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(r.fileCount).toBeGreaterThanOrEqual(2);
      expect(r.totalBytes).toBeGreaterThan(0);
      // All files have content of declared length.
      for (const f of r.files) {
        const actualBytes = f.isBinary ? Buffer.from(f.content, "base64").length : Buffer.byteLength(f.content, "utf8");
        expect(f.bytes).toBe(actualBytes);
      }
    });
  }
});

describe("scaffold — file ordering invariance", () => {
  it("files in result are sorted by path (canonical)", () => {
    const m = getTemplateManifest("typescript-functions", "2.4.0")!;
    const r = scaffold({ manifest: m, parameters: {}, repositoryRid: REPO_RID, repoDisplayName: "x" });
    const paths = r.files.map((f) => f.path);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual(sorted);
  });
});
