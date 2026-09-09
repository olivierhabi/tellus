// ---------------------------------------------------------------------------
// Unit tests for the extracted code-repository route helpers
// (src/services/codeRepository/admin/routeHelpers.ts).
//
// All pure: validators, ETag/SHA parsers, principal derivation, signature
// normalization, semver comparison, and the repo row projector.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  compareSemverLoose,
  unwrapObjectSetRows,
  derivePrincipalSubUuid,
  deriveSignatureFromSource,
  isLegalBranchName,
  isUuidV4,
  parseVersionEtagOrNull,
  repoToResponse,
  toWireSignature,
  validateCreateBody,
} from "../../../src/services/codeRepository/admin/routeHelpers";
import {
  computeImportsEtag,
  parseImportsEtag,
  validateImportsBody,
} from "../../../src/services/codeRepository/admin/importsValidators";
import {
  parseShaIfMatch,
  validateCommitBody,
} from "../../../src/services/codeRepository/admin/commitValidators";

describe("routeHelpers — isUuidV4 / derivePrincipalSubUuid", () => {
  it("accepts only v4 UUIDs", () => {
    expect(isUuidV4("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isUuidV4("123e4567-e89b-12d3-a456-426614174000")).toBe(false); // v1
    expect(isUuidV4("not-a-uuid")).toBe(false);
    expect(isUuidV4("")).toBe(false);
  });

  it("derives a stable v4-shaped UUID per userId", () => {
    const a = derivePrincipalSubUuid("alice");
    const b = derivePrincipalSubUuid("alice");
    const c = derivePrincipalSubUuid("bob");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(isUuidV4(a)).toBe(true);
  });
});

describe("routeHelpers — ETag / SHA parsers", () => {
  it("parseVersionEtagOrNull accepts W/\"n\" and \"n\", rejects the rest", () => {
    expect(parseVersionEtagOrNull('W/"7"')).toBe(7);
    expect(parseVersionEtagOrNull('"7"')).toBe(7);
    expect(parseVersionEtagOrNull('"0"')).toBe(0);
    expect(parseVersionEtagOrNull("not-a-version")).toBeNull();
    expect(parseVersionEtagOrNull('W/"abc"')).toBeNull();
    expect(parseVersionEtagOrNull("")).toBeNull();
  });

  it("parseShaIfMatch accepts strong/weak 40-hex SHAs, lowercases", () => {
    const sha = "a".repeat(40);
    expect(parseShaIfMatch(`"${sha}"`)).toBe(sha);
    expect(parseShaIfMatch(`W/"${sha.toUpperCase()}"`)).toBe(sha);
    expect(parseShaIfMatch('W/"7"')).toBeNull();
    expect(parseShaIfMatch("a".repeat(39))).toBeNull();
    expect(parseShaIfMatch("")).toBeNull();
  });

  it("parseImportsEtag accepts the W/\"etag\" form", () => {
    expect(parseImportsEtag('W/"abc123"')).toBe("abc123");
    expect(parseImportsEtag('"empty"')).toBe("empty");
    expect(parseImportsEtag("abc123")).toBeNull();
  });
});

describe("routeHelpers — isLegalBranchName", () => {
  it("accepts normal branch names", () => {
    expect(isLegalBranchName("main")).toBe(true);
    expect(isLegalBranchName("feature/foo-bar_1.2")).toBe(true);
  });

  it("rejects pathological names", () => {
    expect(isLegalBranchName("")).toBe(false);
    expect(isLegalBranchName("-nope")).toBe(false);
    expect(isLegalBranchName("/nope")).toBe(false);
    expect(isLegalBranchName("a..b")).toBe(false);
    expect(isLegalBranchName("a@{b")).toBe(false);
    expect(isLegalBranchName("a\\b")).toBe(false);
    expect(isLegalBranchName("x.lock")).toBe(false);
    expect(isLegalBranchName("has space")).toBe(false);
    expect(isLegalBranchName(42)).toBe(false);
    expect(isLegalBranchName("x".repeat(256))).toBe(false);
  });
});

describe("routeHelpers — computeImportsEtag", () => {
  it("is empty for the empty set and order-insensitive otherwise", () => {
    expect(computeImportsEtag([])).toBe("empty");
    const a = computeImportsEtag([
      { kind: "object_type", apiName: "B" },
      { kind: "link_type", apiName: "A" },
    ]);
    const b = computeImportsEtag([
      { kind: "link_type", apiName: "A" },
      { kind: "object_type", apiName: "B" },
    ]);
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
    expect(computeImportsEtag([{ kind: "object_type", apiName: "C" }])).not.toBe(a);
  });
});

describe("routeHelpers — validateImportsBody", () => {
  it("accepts a well-formed body and normalizes optional fields", () => {
    const r = validateImportsBody({
      ontologyRid: "ri.ontology.x",
      items: [{ kind: "object_type", apiName: "Foo" }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ontologyRid).toBe("ri.ontology.x");
    expect(r.items).toEqual([{ kind: "object_type", apiName: "Foo", rid: undefined, displayName: undefined }]);
  });

  it("rejects non-objects, non-array items, over-limit items, and bad entries", () => {
    expect(validateImportsBody(null).ok).toBe(false);
    expect(validateImportsBody({ items: "x", ontologyRid: "r" }).ok).toBe(false);
    expect(validateImportsBody({ items: new Array(501).fill({ kind: "object_type", apiName: "A" }), ontologyRid: "r" }).ok).toBe(false);
    expect(validateImportsBody({ items: [], ontologyRid: "r" })).toEqual({ ok: true, ontologyRid: "r", items: [] });
    expect(validateImportsBody({ items: [{ kind: "nope", apiName: "A" }], ontologyRid: "r" }).ok).toBe(false);
    expect(validateImportsBody({ items: [{ kind: "object_type", apiName: "9bad" }], ontologyRid: "r" }).ok).toBe(false);
    expect(validateImportsBody({
      items: [
        { kind: "object_type", apiName: "A" },
        { kind: "object_type", apiName: "A" },
      ],
      ontologyRid: "r",
    }).ok).toBe(false);
    // same apiName under different kinds is fine
    expect(validateImportsBody({
      items: [
        { kind: "object_type", apiName: "A" },
        { kind: "link_type", apiName: "A" },
      ],
      ontologyRid: "r",
    }).ok).toBe(true);
    // items≠[] requires ontologyRid
    expect(validateImportsBody({ items: [{ kind: "object_type", apiName: "A" }] }).ok).toBe(false);
    // legacy ontologyId alias still works
    expect(validateImportsBody({ items: [{ kind: "object_type", apiName: "A" }], ontologyId: "legacy" }).ok).toBe(true);
  });
});

describe("routeHelpers — validateCommitBody", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

  it("accepts a valid add/modify/delete mix", () => {
    const r = validateCommitBody({
      message: "wip",
      fileChanges: [
        { path: "a.ts", op: "add", contentBase64: b64("x") },
        { path: "b.ts", op: "modify", contentBase64: b64("y"), mode: "100755" },
        { path: "c.ts", op: "delete" },
      ],
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.message).toBe("wip");
    expect(r.files).toHaveLength(2);
    expect(r.files[1]?.mode).toBe("100755");
    expect(r.deletePaths).toEqual(["c.ts"]);
  });

  it("rejects empty changesets, bad ops, bad base64, deletes with content, duplicates", () => {
    expect(validateCommitBody({ message: "x", fileChanges: [] })).toMatchObject({ kind: "invalid", errorName: "CodeRepos:EmptyChangeSet" });
    expect(validateCommitBody({ message: "", fileChanges: [{ path: "a", op: "add", contentBase64: b64("x") }] })).toMatchObject({ kind: "invalid" });
    expect(validateCommitBody({ message: "x", fileChanges: [{ path: "a", op: "rename", contentBase64: b64("x") }] }))
      .toMatchObject({ kind: "invalid", errorName: "CodeRepos:InvalidSettings" });
    expect(validateCommitBody({ message: "x", fileChanges: [{ path: "a", op: "add", contentBase64: "!!!not-base64!!!" }] }))
      .toMatchObject({ kind: "invalid" });
    expect(validateCommitBody({ message: "x", fileChanges: [{ path: "a", op: "delete", contentBase64: b64("x") }] }))
      .toMatchObject({ kind: "invalid" });
    expect(validateCommitBody({
      message: "x",
      fileChanges: [
        { path: "a", op: "add", contentBase64: b64("x") },
        { path: "a", op: "delete" },
      ],
    })).toMatchObject({ kind: "invalid" });
    expect(validateCommitBody("nope")).toMatchObject({ kind: "invalid" });
  });
});

describe("routeHelpers — validateCreateBody", () => {
  const good = {
    displayName: "repo",
    parentFolderRid: "ri.compass.main.folder.123e4567-e89b-42d3-a456-426614174000",
    templateId: "t",
    templateVersion: "v1",
  };

  it("accepts a full body and defaults the branch to main", () => {
    const r = validateCreateBody(good);
    expect(r).toMatchObject({ kind: "ok" });
    if (r.kind !== "ok") return;
    expect(r.body.defaultBranch).toBe("main");
    expect(validateCreateBody({ ...good, defaultBranch: "dev" })).toMatchObject({
      kind: "ok",
      body: expect.objectContaining({ defaultBranch: "dev" }),
    });
  });

  it("rejects bad fields", () => {
    expect(validateCreateBody({ ...good, displayName: "" })).toMatchObject({
      kind: "invalid", parameters: { field: "displayName" },
    });
    expect(validateCreateBody({ ...good, parentFolderRid: "nope" })).toMatchObject({
      kind: "invalid", parameters: { field: "parentFolderRid" },
    });
    expect(validateCreateBody({ ...good, templateId: "" })).toMatchObject({
      kind: "invalid", parameters: { field: "templateId" },
    });
  });
});

describe("routeHelpers — compareSemverLoose", () => {
  it("orders releases numerically and pre-releases below releases", () => {
    expect(compareSemverLoose("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemverLoose("1.10.0", "1.2.0")).toBeGreaterThan(0);
    expect(compareSemverLoose("2.0.0", "10.0.0")).toBeLessThan(0);
    expect(compareSemverLoose("1.0.0-alpha.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemverLoose("1.0.0-alpha.1", "1.0.0-alpha.2")).toBeLessThan(0);
  });
});

describe("routeHelpers — repoToResponse", () => {
  it("projects snake_case rows to camelCase wire shape", () => {
    const out = repoToResponse({
      rid: "r1",
      display_name: "Repo",
      parent_folder_rid: "pf",
      project_rid: "pj",
      template_id: "t",
      template_version: "1",
      default_branch: "main",
      settings_json: { a: 1 },
      state: "ACTIVE",
      created_by: "u",
      created_at: new Date("2024-01-01T00:00:00Z"),
      updated_at: new Date("2024-01-02T00:00:00Z"),
      resource_version: "3" as unknown as number,
    });
    expect(out).toMatchObject({
      rid: "r1",
      displayName: "Repo",
      parentFolderRid: "pf",
      defaultBranch: "main",
      resourceVersion: 3,
    });
  });
});

describe("routeHelpers — toWireSignature / deriveSignatureFromSource", () => {
  it("returns null for non-objects and missing parameters", () => {
    expect(toWireSignature(null)).toBeNull();
    expect(toWireSignature({})).toBeNull();
    expect(toWireSignature({ parameters: "x" })).toBeNull();
  });

  it("normalizes manifest records, defaulting positions and unsupported types", () => {
    const out = toWireSignature({
      parameters: [
        { name: "a", type: "string", typeModel: { kind: "string" }, optional: false, hasDefault: false },
        { name: "b", type: "Client" },
      ],
      output: "void",
    });
    expect(out?.parameters).toHaveLength(2);
    expect(out?.parameters[1]).toMatchObject({
      name: "b",
      position: 1,
      typeModel: { kind: "unsupported", typeText: "Client" },
      optional: false,
      hasDefault: false,
    });
    expect(out?.output).toBe("void");
  });

  it("deriveSignatureFromSource fail-opens to null on unparseable source", () => {
    expect(deriveSignatureFromSource("bad.ts", "this is not typescript {{{")).toBeNull();
  });
});

describe("routeHelpers — unwrapObjectSetRows (ObjectSet wire shape)", () => {
  it("unwraps the legacy single-key {rows} shape", () => {
    expect(unwrapObjectSetRows({ rows: [{ id: "1" }] })).toEqual([{ id: "1" }]);
  });

  it("unwraps the widened ObjectSet shape (rows + objectType/snapshot/recordLoad)", () => {
    // Since the link-pivot work, ObjectSet carries metadata fields alongside
    // rows; the serialized result must still reach the wire as a bare array.
    const snapshot = { objects: new Map() };
    const recordLoad = () => undefined;
    expect(
      unwrapObjectSetRows({ rows: [], objectType: "AckManualSrc", snapshot, recordLoad }),
    ).toEqual([]);
  });

  it("unwraps subsets of the metadata keys (structured clone drops functions)", () => {
    expect(unwrapObjectSetRows({ rows: [{ id: "1" }], objectType: "T" })).toEqual([{ id: "1" }]);
  });

  it("leaves non-ObjectSet shapes untouched", () => {
    expect(unwrapObjectSetRows({ rows: "not-an-array" })).toEqual({ rows: "not-an-array" });
    expect(unwrapObjectSetRows({ rows: [], unexpected: 1 })).toEqual({ rows: [], unexpected: 1 });
    expect(unwrapObjectSetRows({ data: [1, 2] })).toEqual({ data: [1, 2] });
    expect(unwrapObjectSetRows([1, 2])).toEqual([1, 2]);
    expect(unwrapObjectSetRows(null)).toBeNull();
    expect(unwrapObjectSetRows("scalar")).toBe("scalar");
    expect(unwrapObjectSetRows(undefined)).toBeUndefined();
  });
});
