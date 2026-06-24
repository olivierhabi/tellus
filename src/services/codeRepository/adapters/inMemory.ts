// ---------------------------------------------------------------------------
// B2 — in-memory test adapters for the createRepository saga.
//
// Used by integration tests against the saga executor. Each one supports:
//   - A "scripted-failure" mode for testing each saga branch deterministically.
//   - Idempotent compensation (release/tombstone may be called twice).
//
// These adapters are tests-only by usage; they live under src/ so the
// production-mode app factory can wire test-mode in via a single
// constructor argument when CODE_REPOS_TEST_MODE=1.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import type {
  CompassAdapter,
  CompassReserveArgs,
  CompassReserveOutcome,
  StemmaAdapter,
  StemmaCommitFilesArgs,
  StemmaCommitFilesOutcome,
  StemmaCreateArgs,
  StemmaCreateOutcome,
  StemmaListTreeArgs,
  StemmaListTreeOutcome,
  StemmaReadBlobArgs,
  StemmaReadBlobOutcome,
  StemmaTreeEntry,
  TemplateAdapter,
  TemplateScaffoldArgs,
  TemplateScaffoldOutcome,
} from "./types";
import { projectTree, synthesizeTree } from "../stemma/treeFilter";
import { getTemplateManifest } from "../../templates/manifest";

// ---------------------------------------------------------------------------
// In-memory Compass adapter.
// ---------------------------------------------------------------------------

export interface InMemoryCompassConfig {
  /** When set, all reserve() calls return this outcome instead of doing the work. */
  readonly forceOutcome?: CompassReserveOutcome;
  /** When set, release() calls throw (compensation-failure tests). */
  readonly releaseShouldThrow?: boolean;
}

export class InMemoryCompass implements CompassAdapter {
  private reservations = new Map<
    string,
    { displayName: string; parentFolderRid: string }
  >();
  /** (parent_rid, lower(displayName)) → resourceRid for conflict detection. */
  private nameIndex = new Map<string, string>();
  /** released RIDs — for idempotency check. */
  private released = new Set<string>();

  constructor(private readonly cfg: InMemoryCompassConfig = {}) {}

  async reserve(args: CompassReserveArgs): Promise<CompassReserveOutcome> {
    if (this.cfg.forceOutcome) return this.cfg.forceOutcome;

    const key = `${args.parentFolderRid}|${args.displayName.toLowerCase()}`;
    if (this.nameIndex.has(key)) {
      return { kind: "name-conflict" };
    }
    const resourceRid = args.proposedRid;
    this.reservations.set(resourceRid, {
      displayName: args.displayName,
      parentFolderRid: args.parentFolderRid,
    });
    this.nameIndex.set(key, resourceRid);
    return {
      kind: "ok",
      resourceRid,
      projectRid: `ri.compass.main.project.${randomUUID()}`,
    };
  }

  async release(args: { resourceRid: string }): Promise<void> {
    if (this.cfg.releaseShouldThrow) {
      throw new Error("simulated compass.release failure");
    }
    this.released.add(args.resourceRid);
    const r = this.reservations.get(args.resourceRid);
    if (!r) return; // idempotent — release-of-released is OK
    const key = `${r.parentFolderRid}|${r.displayName.toLowerCase()}`;
    this.reservations.delete(args.resourceRid);
    this.nameIndex.delete(key);
  }

  // Test introspection.
  isReserved(rid: string): boolean {
    return this.reservations.has(rid);
  }
  isReleased(rid: string): boolean {
    return this.released.has(rid);
  }
  reservationCount(): number {
    return this.reservations.size;
  }
}

// ---------------------------------------------------------------------------
// In-memory Stemma adapter.
// ---------------------------------------------------------------------------

export interface InMemoryStemmaConfig {
  readonly forceOutcome?: StemmaCreateOutcome;
  readonly tombstoneShouldThrow?: boolean;
  /** When set, all `commitFiles()` calls return this outcome instead. */
  readonly forceCommitOutcome?: StemmaCommitFilesOutcome;
}

/** A test seed: one branch's worth of files. */
export interface SeedFile {
  readonly path: string;
  /** UTF-8 text or raw bytes. */
  readonly content: string | Uint8Array;
  /** git mode; defaults to "100644". */
  readonly mode?: string;
}

export interface SeedBranch {
  readonly headCommitSha: string;
  readonly files: ReadonlyArray<SeedFile>;
}

interface BlobRecord {
  readonly sha: string;
  readonly mode: string;
  readonly content: Uint8Array;
}

interface BranchRecord {
  readonly head: string;
  readonly files: Map<string, BlobRecord>;
}

export class InMemoryStemma implements StemmaAdapter {
  private repos = new Set<string>();
  private tombstoned = new Set<string>();
  private branches = new Map<string, Map<string, BranchRecord>>();

  constructor(private readonly cfg: InMemoryStemmaConfig = {}) {}

  async createRepository(
    args: StemmaCreateArgs,
  ): Promise<StemmaCreateOutcome> {
    if (this.cfg.forceOutcome) return this.cfg.forceOutcome;
    this.repos.add(args.proposedRid);
    // Initialize an empty bare repo: the branch record exists with no
    // files. The saga's step 3 (template.scaffoldAndPush) is responsible
    // for committing the template's file list. Tests that need a
    // pre-seeded branch use `seedBranch(...)` directly.
    let r = this.branches.get(args.proposedRid);
    if (!r) {
      r = new Map();
      this.branches.set(args.proposedRid, r);
    }
    if (!r.has(args.defaultBranchName)) {
      r.set(args.defaultBranchName, {
        head: deterministicSha(
          `${args.proposedRid}:${args.defaultBranchName}:initial`,
        ),
        files: new Map(),
      });
    }
    return { kind: "ok", repositoryRid: args.proposedRid };
  }

  async commitFiles(
    args: StemmaCommitFilesArgs,
  ): Promise<StemmaCommitFilesOutcome> {
    if (this.cfg.forceCommitOutcome) return this.cfg.forceCommitOutcome;
    if (this.tombstoned.has(args.repositoryRid)) {
      return { kind: "branch-not-found" };
    }
    let repo = this.branches.get(args.repositoryRid);
    if (!repo) {
      // The saga normally calls createRepository first, which initializes
      // the branch record. If a caller commits without doing so, treat it
      // as branch-not-found rather than silently auto-creating — keeps the
      // contract honest about adapter ordering.
      if (!this.repos.has(args.repositoryRid)) {
        return { kind: "branch-not-found" };
      }
      repo = new Map();
      this.branches.set(args.repositoryRid, repo);
    }
    let branch = repo.get(args.branch);
    if (!branch) {
      return { kind: "branch-not-found" };
    }

    // F4 spec line 957: "parentSha must equal current HEAD". Reject with
    // stale-ref before any mutation if the optimistic-concurrency fence
    // is set and mismatched. Real-Stemma deployments enforce this via
    // JGit's RefUpdate#setExpectedOldObjectId so the check is atomic with
    // the ref write — in-memory we just compare under the JS event loop's
    // implicit serialization (single-threaded).
    if (args.parentSha !== undefined && args.parentSha !== branch.head) {
      return {
        kind: "stale-ref",
        expectedSha: args.parentSha,
        currentHead: branch.head,
      };
    }

    // Adapter contract guard: a commit cannot both upsert and delete the
    // same path. Catching it here keeps the in-memory and real-Stemma
    // implementations from diverging on degenerate input.
    const upsertPaths = new Set(args.files.map((f) => f.path));
    const deletes = args.deletePaths ?? [];
    for (const d of deletes) {
      if (upsertPaths.has(d)) {
        return {
          kind: "transient",
          reason: `delete-overlaps-upsert:${d}`,
        };
      }
    }

    let totalBytes = 0;
    const files = new Map<string, BlobRecord>(branch.files);
    for (const f of args.files) {
      files.set(f.path, {
        sha: blobSha(f.content),
        mode: f.mode,
        content: f.content,
      });
      totalBytes += f.content.byteLength;
    }
    // Deletes after upserts (the overlap check above means order doesn't
    // affect outcome, but this matches the Map mutation order most readers
    // expect when stepping through in a debugger).
    for (const d of deletes) {
      files.delete(d);
    }
    const head = deterministicSha(
      `${args.repositoryRid}:${args.branch}:${args.message}:${[...files.keys()].sort().join(":")}`,
    );
    repo.set(args.branch, { head, files });
    return {
      kind: "ok",
      commitSha: head,
      fileCount: args.files.length + deletes.length,
      totalBytes,
    };
  }

  async createBranch(
    args: import("./types").StemmaCreateBranchArgs,
  ): Promise<import("./types").StemmaCreateBranchOutcome> {
    if (this.tombstoned.has(args.repositoryRid)) return { kind: "source-not-found" };
    const repo = this.branches.get(args.repositoryRid);
    const src = repo?.get(args.fromBranch);
    if (!repo || !src) return { kind: "source-not-found" };
    if (repo.has(args.newBranch)) return { kind: "branch-exists" };
    // Fork the full file set + head into the new branch.
    repo.set(args.newBranch, { head: src.head, files: new Map(src.files) });
    return { kind: "ok", head: src.head };
  }

  async deleteBranch(
    args: import("./types").StemmaDeleteBranchArgs,
  ): Promise<import("./types").StemmaDeleteBranchOutcome> {
    if (this.tombstoned.has(args.repositoryRid)) return { kind: "not-found" };
    const repo = this.branches.get(args.repositoryRid);
    if (!repo || !repo.has(args.branch)) return { kind: "not-found" };
    repo.delete(args.branch);
    return { kind: "ok" };
  }

  async listBranches(
    args: { repositoryRid: string },
  ): Promise<import("./types").StemmaListBranchesOutcome> {
    if (this.tombstoned.has(args.repositoryRid)) return { kind: "not-found" };
    const repo = this.branches.get(args.repositoryRid);
    if (!repo) return { kind: "not-found" };
    return {
      kind: "ok",
      branches: [...repo.entries()]
        .map(([name, rec]) => ({ name, head: rec.head }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async tombstone(args: { repositoryRid: string }): Promise<void> {
    if (this.cfg.tombstoneShouldThrow) {
      throw new Error("simulated stemma.tombstone failure");
    }
    this.tombstoned.add(args.repositoryRid);
    this.branches.delete(args.repositoryRid);
  }

  exists(rid: string): boolean {
    return this.repos.has(rid);
  }
  isTombstoned(rid: string): boolean {
    return this.tombstoned.has(rid);
  }

  /**
   * Seed (or replace) a branch's file list. Test-only; not part of the
   * adapter interface — callers cast to InMemoryStemma when they need it.
   */
  seedBranch(
    repositoryRid: string,
    branch: string,
    seed: SeedBranch,
  ): void {
    let r = this.branches.get(repositoryRid);
    if (!r) {
      r = new Map();
      this.branches.set(repositoryRid, r);
    }
    const fileMap = new Map<string, BlobRecord>();
    for (const f of seed.files) {
      const buf =
        typeof f.content === "string"
          ? new Uint8Array(Buffer.from(f.content, "utf8"))
          : f.content;
      fileMap.set(f.path, {
        sha: blobSha(buf),
        mode: f.mode ?? "100644",
        content: buf,
      });
    }
    r.set(branch, { head: seed.headCommitSha, files: fileMap });
    this.repos.add(repositoryRid);
  }

  async listTree(args: StemmaListTreeArgs): Promise<StemmaListTreeOutcome> {
    if (this.tombstoned.has(args.repositoryRid)) {
      return { kind: "branch-not-found" };
    }
    const repo = this.branches.get(args.repositoryRid);
    if (!repo) return { kind: "branch-not-found" };
    const branch = repo.get(args.branch);
    if (!branch) return { kind: "branch-not-found" };

    const blobs = [...branch.files.entries()].map(([path, b]) => ({
      path,
      mode: b.mode,
      sha: b.sha,
      size: b.content.byteLength,
    }));
    const all = synthesizeTree(blobs, (dir) =>
      deterministicSha(`tree:${args.repositoryRid}:${args.branch}:${dir}`),
    );
    if (args.path !== "") {
      const exists = all.some(
        (e) => e.path === args.path && e.type === "tree",
      );
      if (!exists) return { kind: "path-not-found" };
    }
    const projected = projectTree(all, args.path, args.depth);
    return {
      kind: "ok",
      entries: projected as readonly StemmaTreeEntry[],
      truncated: false,
      branchHead: branch.head,
      treeSha: treeProjectionSha(projected),
    };
  }

  async readBlob(args: StemmaReadBlobArgs): Promise<StemmaReadBlobOutcome> {
    if (this.tombstoned.has(args.repositoryRid)) {
      return { kind: "branch-not-found" };
    }
    const repo = this.branches.get(args.repositoryRid);
    if (!repo) return { kind: "branch-not-found" };
    const branch = repo.get(args.branch);
    if (!branch) return { kind: "branch-not-found" };
    const f = branch.files.get(args.path);
    if (!f) {
      const dirPrefix = `${args.path}/`;
      for (const p of branch.files.keys()) {
        if (p.startsWith(dirPrefix)) return { kind: "path-is-tree" };
      }
      return { kind: "path-not-found" };
    }
    return {
      kind: "ok",
      content: f.content,
      sha: f.sha,
      size: f.content.byteLength,
    };
  }
}

// ---------------------------------------------------------------------------
// Hash helpers — git-shaped (40 hex) so frontend code that displays the
// SHA renders sensibly. Not git-format-compatible; the in-memory adapter
// has no need to be byte-for-byte identical with git's blob hashing.
// ---------------------------------------------------------------------------

function blobSha(buf: Uint8Array): string {
  return createHash("sha1").update(buf).digest("hex");
}

function deterministicSha(seed: string): string {
  return createHash("sha1").update(seed).digest("hex");
}

function treeProjectionSha(
  entries: ReadonlyArray<{
    path: string;
    type: string;
    mode: string;
    sha: string;
    size?: number;
  }>,
): string {
  const h = createHash("sha1");
  for (const e of entries) {
    h.update(`${e.path}\0${e.type}\0${e.mode}\0${e.sha}\0${e.size ?? ""}\n`);
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// In-memory Template adapter.
// ---------------------------------------------------------------------------

export interface InMemoryTemplateConfig {
  readonly forceOutcome?: TemplateScaffoldOutcome;
  /** Map of templateId → known set; reserve returns NOT_FOUND for missing. */
  readonly knownTemplates?: ReadonlySet<string>;
  /**
   * When set, scaffoldAndPush actually materializes the manifest's files
   * by calling `stemma.commitFiles(...)`. When unset, the adapter falls
   * back to a synthesized OK outcome (legacy behavior — used by tests
   * that only need the saga to succeed and don't care about file content).
   */
  readonly stemma?: StemmaAdapter;
}

export class InMemoryTemplate implements TemplateAdapter {
  private known: ReadonlySet<string>;
  private scaffolds = new Map<string, { commitSha: string }>();

  constructor(private readonly cfg: InMemoryTemplateConfig = {}) {
    this.known =
      cfg.knownTemplates ??
      new Set([
        "typescript-functions",
        "python-functions",
        "transforms-python",
        "transforms-java",
        "transforms-sql",
      ]);
  }

  async scaffoldAndPush(
    args: TemplateScaffoldArgs,
  ): Promise<TemplateScaffoldOutcome> {
    if (this.cfg.forceOutcome) return this.cfg.forceOutcome;
    if (!this.known.has(args.templateId)) {
      return {
        kind: "template-not-found",
        templateId: args.templateId,
        version: args.templateVersion,
      };
    }

    // ------------------------------------------------------------------
    // Wired path: read the B3 manifest, substitute parameters across all
    // file paths and content, and call stemma.commitFiles to materialize
    // the scaffold. This is what produces the file tree the file viewer
    // sees on a freshly-created repo.
    // ------------------------------------------------------------------
    if (this.cfg.stemma) {
      const manifest = getTemplateManifest(args.templateId, args.templateVersion);
      if (!manifest) {
        return {
          kind: "template-not-found",
          templateId: args.templateId,
          version: args.templateVersion,
        };
      }
      const params = mergeWithDefaults(args.parameters, manifest);
      let materialized: ReadonlyArray<{
        path: string;
        content: Uint8Array;
        mode: "100644" | "100755";
      }>;
      try {
        materialized = manifest.files.map((f) => {
          const path = applyTemplate(f.path, params);
          // Substitute UTF-8 file content; binary files (base64 in the
          // manifest) get decoded as-is without substitution to keep
          // bytes intact.
          const content = f.isBinary
            ? Buffer.from(f.content, "base64")
            : Buffer.from(applyTemplate(f.content, params), "utf8");
          return {
            path,
            content: new Uint8Array(content),
            mode: f.mode,
          };
        });
      } catch (err) {
        return {
          kind: "init-failed",
          reason: `parameter-substitution-failed: ${(err as Error).message}`,
        };
      }
      const out = await this.cfg.stemma.commitFiles({
        repositoryRid: args.repositoryRid,
        branch: args.targetBranch,
        files: materialized,
        message: `Initial commit from template ${args.templateId}@${args.templateVersion}`,
        principalSub: args.principalSub,
      });
      if (out.kind !== "ok") {
        return {
          kind: "init-failed",
          reason:
            out.kind === "branch-not-found"
              ? "branch-not-found-on-stemma"
              : `stemma-${out.kind}`,
        };
      }
      this.scaffolds.set(args.repositoryRid, { commitSha: out.commitSha });
      return {
        kind: "ok",
        commitSha: out.commitSha,
        fileCount: out.fileCount,
        totalBytes: out.totalBytes,
      };
    }

    // ------------------------------------------------------------------
    // Legacy fallback (no stemma wired): preserve the previous fake-commit
    // outcome so existing unit tests that don't care about file content
    // continue to work without setup churn.
    // ------------------------------------------------------------------
    const commitSha = generateFakeSha(args.repositoryRid + args.templateId);
    this.scaffolds.set(args.repositoryRid, { commitSha });
    return {
      kind: "ok",
      commitSha,
      fileCount: 8,
      totalBytes: 12_345,
    };
  }

  scaffoldedFor(rid: string): string | undefined {
    return this.scaffolds.get(rid)?.commitSha;
  }
}

// ---------------------------------------------------------------------------
// Template parameter substitution helpers.
//
// `{{name}}` placeholders in path or UTF-8 content. Missing required
// parameters (no default in manifest, not provided by caller) throw — the
// scaffolder converts that into an `init-failed` outcome upstream.
// ---------------------------------------------------------------------------

function mergeWithDefaults(
  provided: Readonly<Record<string, string>>,
  manifest: { parameters: ReadonlyArray<{ name: string; default?: string }> },
): Record<string, string> {
  const out: Record<string, string> = { ...provided };
  for (const p of manifest.parameters) {
    if (out[p.name] === undefined && p.default !== undefined) {
      out[p.name] = p.default;
    }
  }
  return out;
}

function applyTemplate(
  source: string,
  params: Readonly<Record<string, string>>,
): string {
  return source.replace(/\{\{(\w+)\}\}/g, (_match, name) => {
    const v = params[name];
    if (v === undefined) {
      throw new Error(`missing template parameter: ${name}`);
    }
    return v;
  });
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function generateFakeSha(seed: string): string {
  // Deterministic 40-char hex: sha1-shaped, derived from a seed string
  // hashed with FNV-1a. Used only for in-memory adapter outcomes.
  let h = 0xcbf29ce484222325n;
  const p = 0x100000001b3n;
  for (let i = 0; i < seed.length; i++) {
    h = BigInt.asUintN(64, (h ^ BigInt(seed.charCodeAt(i))) * p);
  }
  // Pad/repeat to 40 chars.
  let hex = h.toString(16).padStart(16, "0");
  while (hex.length < 40) hex = hex + h.toString(16).padStart(16, "0");
  return hex.slice(0, 40);
}
