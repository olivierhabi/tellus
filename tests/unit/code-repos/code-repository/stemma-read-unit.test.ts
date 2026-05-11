// ---------------------------------------------------------------------------
// B2-C-10 / B2-C-11 — unit tests for the stemma read-path helpers and the
// in-memory adapter's listTree/readBlob methods.
//
// Pure-logic; no DB, no Express, no I/O.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  validateDepth,
  validateRelativePath,
} from "../../../../src/services/codeRepository/stemma/path";
import {
  detectBinary,
  matchesAnyMagic,
} from "../../../../src/services/codeRepository/stemma/binary";
import {
  extensionOf,
  mimeForPath,
} from "../../../../src/services/codeRepository/stemma/mime";
import {
  projectTree,
  synthesizeTree,
} from "../../../../src/services/codeRepository/stemma/treeFilter";
import { InMemoryStemma } from "../../../../src/services/codeRepository/adapters/inMemory";

const RID = "ri.stemma.main.repository.0123abcd-ef01-4345-8789-abcdef012345";

// ---------------------------------------------------------------------------
// path.ts
// ---------------------------------------------------------------------------

describe("validateRelativePath", () => {
  it("accepts the empty/null/undefined path as repo root", () => {
    expect(validateRelativePath("")).toEqual({
      ok: true,
      value: { normalized: "", segments: [] },
    });
    expect(validateRelativePath(null)).toEqual({
      ok: true,
      value: { normalized: "", segments: [] },
    });
    expect(validateRelativePath(undefined)).toEqual({
      ok: true,
      value: { normalized: "", segments: [] },
    });
  });

  it("accepts simple relative paths", () => {
    const r = validateRelativePath("src/functions/index.ts");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.normalized).toBe("src/functions/index.ts");
      expect(r.value.segments).toEqual(["src", "functions", "index.ts"]);
    }
  });

  it("rejects absolute paths", () => {
    const r = validateRelativePath("/etc/passwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("absolute");
  });

  it("rejects Windows drive prefixes as absolute", () => {
    const r = validateRelativePath("C:/etc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("absolute");
  });

  it("rejects `..` traversal segments", () => {
    const r = validateRelativePath("src/../etc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("traversal");
  });

  it("rejects `.` segments", () => {
    const r = validateRelativePath("src/./index.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("traversal");
  });

  it("rejects null bytes", () => {
    const r = validateRelativePath("src/index\0.ts");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("null-byte");
  });

  it("rejects `.git` reserved segments", () => {
    const r = validateRelativePath(".git/config");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("git-reserved");
  });

  it("rejects paths > 4 KiB", () => {
    const r = validateRelativePath("a/" + "b".repeat(4096));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("too-long");
  });

  it("rejects non-string inputs", () => {
    const r = validateRelativePath(42 as unknown);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("non-string");
  });
});

describe("validateDepth", () => {
  it("defaults to 1 on empty/null/undefined", () => {
    expect(validateDepth(undefined)).toEqual({ ok: true, value: 1 });
    expect(validateDepth("")).toEqual({ ok: true, value: 1 });
  });

  it("accepts integers in [1,5]", () => {
    for (let d = 1; d <= 5; d++) {
      expect(validateDepth(String(d))).toEqual({ ok: true, value: d });
    }
  });

  it("rejects 0, negative, > 5, non-integer, NaN", () => {
    expect(validateDepth("0").ok).toBe(false);
    expect(validateDepth("-1").ok).toBe(false);
    expect(validateDepth("6").ok).toBe(false);
    expect(validateDepth("1.5").ok).toBe(false);
    expect(validateDepth("abc").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// binary.ts
// ---------------------------------------------------------------------------

describe("detectBinary", () => {
  it("returns false on empty buffer", () => {
    expect(detectBinary(new Uint8Array(0))).toBe(false);
  });

  it("returns false on plain UTF-8 text", () => {
    expect(detectBinary(new Uint8Array(Buffer.from("hello world", "utf8")))).toBe(
      false,
    );
  });

  it("returns true on a buffer with NUL in first 8 KiB", () => {
    const buf = new Uint8Array(64);
    buf[10] = 0x00;
    buf.fill(0x41, 0, 10);
    buf.fill(0x41, 11);
    expect(detectBinary(buf)).toBe(true);
  });

  it("matches PNG magic bytes", () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    expect(matchesAnyMagic(png)).toBe(true);
    expect(detectBinary(png)).toBe(true);
  });

  it("matches JPEG magic bytes", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(matchesAnyMagic(jpeg)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mime.ts
// ---------------------------------------------------------------------------

describe("mimeForPath / extensionOf", () => {
  it("infers MIME from common code extensions", () => {
    expect(mimeForPath("src/index.ts", false)).toBe("text/typescript");
    expect(mimeForPath("README.md", false)).toBe("text/markdown");
    expect(mimeForPath("script.py", false)).toBe("text/x-python");
    expect(mimeForPath("config.yaml", false)).toBe("text/yaml");
  });

  it("returns image MIME for image extensions", () => {
    expect(mimeForPath("logo.png", true)).toBe("image/png");
    expect(mimeForPath("photo.jpeg", true)).toBe("image/jpeg");
    expect(mimeForPath("icon.svg", false)).toBe("image/svg+xml");
  });

  it("falls back to octet-stream/binary or text/plain when unknown", () => {
    expect(mimeForPath("something.xyz", true)).toBe("application/octet-stream");
    expect(mimeForPath("Makefile", false)).toBe("text/plain");
  });

  it("extensionOf is case-insensitive and ignores leading-dot files", () => {
    expect(extensionOf("LICENSE")).toBeNull();
    expect(extensionOf(".gitignore")).toBeNull();
    expect(extensionOf("Foo.TS")).toBe("ts");
  });
});

// ---------------------------------------------------------------------------
// treeFilter.ts
// ---------------------------------------------------------------------------

describe("projectTree", () => {
  const flat = [
    { path: "README.md", type: "blob" as const },
    { path: "src", type: "tree" as const },
    { path: "src/index.ts", type: "blob" as const },
    { path: "src/functions", type: "tree" as const },
    { path: "src/functions/dso.ts", type: "blob" as const },
    { path: "src/functions/index.ts", type: "blob" as const },
  ];

  it("depth=1 from root returns only top-level entries", () => {
    const out = projectTree(flat, "", 1).map((e) => e.path);
    expect(out.sort()).toEqual(["README.md", "src"].sort());
  });

  it("depth=2 from root returns top + one level deeper", () => {
    const out = projectTree(flat, "", 2).map((e) => e.path);
    expect(out).toContain("src/index.ts");
    expect(out).toContain("src/functions");
    expect(out).not.toContain("src/functions/dso.ts");
  });

  it("depth=1 from `src` returns only direct children", () => {
    const out = projectTree(flat, "src", 1).map((e) => e.path);
    expect(out.sort()).toEqual(["src/functions", "src/index.ts"].sort());
  });

  it("returns empty when prefix has no matches", () => {
    expect(projectTree(flat, "nope", 5)).toEqual([]);
  });
});

describe("synthesizeTree", () => {
  it("synthesises directory entries for every distinct ancestor", () => {
    const out = synthesizeTree(
      [
        { path: "src/index.ts", mode: "100644", sha: "a", size: 10 },
        { path: "src/functions/dso.ts", mode: "100644", sha: "b", size: 12 },
      ],
      (dir) => "dir-" + dir,
    );
    const trees = out.filter((e) => e.type === "tree").map((e) => e.path);
    expect(trees.sort()).toEqual(["src", "src/functions"].sort());
    const blobs = out.filter((e) => e.type === "blob").map((e) => e.path);
    expect(blobs.sort()).toEqual(
      ["src/index.ts", "src/functions/dso.ts"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// InMemoryStemma listTree / readBlob
// ---------------------------------------------------------------------------

describe("InMemoryStemma.listTree", () => {
  it("returns branch-not-found when the rid is unknown", async () => {
    const s = new InMemoryStemma();
    const r = await s.listTree({
      repositoryRid: RID,
      branch: "main",
      path: "",
      depth: 1,
    });
    expect(r.kind).toBe("branch-not-found");
  });

  it("lists files seeded via seedBranch at root depth=1", async () => {
    // Post-DEFAULT_SCAFFOLD removal: createRepository creates an EMPTY
    // bare repo. The test seeds files explicitly via seedBranch, which
    // is the unit-test analogue of what stemma.commitFiles does in the
    // saga's step 3.
    const s = new InMemoryStemma();
    await s.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "alice",
    });
    s.seedBranch(RID, "main", {
      headCommitSha: "0000000000000000000000000000000000000001",
      files: [
        { path: "README.md", content: "# demo" },
        { path: "src/index.ts", content: "export {}" },
      ],
    });
    const r = await s.listTree({
      repositoryRid: RID,
      branch: "main",
      path: "",
      depth: 1,
    });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      const names = r.entries.map((e) => e.path);
      expect(names).toContain("README.md");
      expect(names).toContain("src");
      expect(names).not.toContain("src/index.ts"); // depth=1
      expect(r.treeSha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("path-not-found when the prefix does not exist", async () => {
    const s = new InMemoryStemma();
    await s.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "alice",
    });
    const r = await s.listTree({
      repositoryRid: RID,
      branch: "main",
      path: "no-such-dir",
      depth: 1,
    });
    expect(r.kind).toBe("path-not-found");
  });

  it("treeSha is stable across calls with same inputs", async () => {
    const s = new InMemoryStemma();
    await s.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "alice",
    });
    const a = await s.listTree({
      repositoryRid: RID,
      branch: "main",
      path: "",
      depth: 2,
    });
    const b = await s.listTree({
      repositoryRid: RID,
      branch: "main",
      path: "",
      depth: 2,
    });
    if (a.kind === "ok" && b.kind === "ok") {
      expect(a.treeSha).toBe(b.treeSha);
    } else {
      throw new Error("expected ok");
    }
  });

  it("treeSha changes when the tree changes", async () => {
    const s = new InMemoryStemma();
    await s.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "alice",
    });
    const before = await s.listTree({
      repositoryRid: RID,
      branch: "main",
      path: "",
      depth: 2,
    });
    s.seedBranch(RID, "main", {
      headCommitSha: "0000000000000000000000000000000000000002",
      files: [{ path: "README.md", content: "# changed" }],
    });
    const after = await s.listTree({
      repositoryRid: RID,
      branch: "main",
      path: "",
      depth: 2,
    });
    if (before.kind === "ok" && after.kind === "ok") {
      expect(after.treeSha).not.toBe(before.treeSha);
    } else {
      throw new Error("expected ok");
    }
  });

  it("returns branch-not-found after tombstone", async () => {
    const s = new InMemoryStemma();
    await s.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "alice",
    });
    await s.tombstone({ repositoryRid: RID });
    const r = await s.listTree({
      repositoryRid: RID,
      branch: "main",
      path: "",
      depth: 1,
    });
    expect(r.kind).toBe("branch-not-found");
  });
});

describe("InMemoryStemma.readBlob", () => {
  it("returns the seeded README.md as utf-8 bytes", async () => {
    const s = new InMemoryStemma();
    await s.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "alice",
    });
    s.seedBranch(RID, "main", {
      headCommitSha: "0000000000000000000000000000000000000003",
      files: [{ path: "README.md", content: "# tellus repository\n" }],
    });
    const r = await s.readBlob({
      repositoryRid: RID,
      branch: "main",
      path: "README.md",
    });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      const text = Buffer.from(r.content).toString("utf8");
      expect(text).toMatch(/tellus repository/);
      expect(r.size).toBe(r.content.byteLength);
      expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("returns path-is-tree when caller asks for a directory", async () => {
    const s = new InMemoryStemma();
    await s.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "alice",
    });
    s.seedBranch(RID, "main", {
      headCommitSha: "0000000000000000000000000000000000000004",
      files: [{ path: "src/index.ts", content: "export {}" }],
    });
    const r = await s.readBlob({
      repositoryRid: RID,
      branch: "main",
      path: "src",
    });
    expect(r.kind).toBe("path-is-tree");
  });

  it("returns path-not-found for an unknown path", async () => {
    const s = new InMemoryStemma();
    await s.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "alice",
    });
    const r = await s.readBlob({
      repositoryRid: RID,
      branch: "main",
      path: "nope.ts",
    });
    expect(r.kind).toBe("path-not-found");
  });

  it("returns branch-not-found for an unknown branch", async () => {
    const s = new InMemoryStemma();
    await s.createRepository({
      proposedRid: RID,
      defaultBranchName: "main",
      principalSub: "alice",
    });
    const r = await s.readBlob({
      repositoryRid: RID,
      branch: "release",
      path: "README.md",
    });
    expect(r.kind).toBe("branch-not-found");
  });
});
