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
  /** When false, suppresses auto-seed of the default-branch scaffold. */
  readonly autoSeedDefaultTree?: boolean;
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
    if (this.cfg.autoSeedDefaultTree !== false) {
      this.seedBranch(args.proposedRid, args.defaultBranchName, {
        headCommitSha: deterministicSha(
          `${args.proposedRid}:${args.defaultBranchName}:initial`,
        ),
        files: DEFAULT_SCAFFOLD,
      });
    }
    return { kind: "ok", repositoryRid: args.proposedRid };
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
// Default scaffold seeded by createRepository — mirrors the shape of
// the typescript-functions template (B3) so the file-viewer demo (F2-C-03)
// has something meaningful to render before B3's real scaffold lands on
// the read path.
// ---------------------------------------------------------------------------

const DEFAULT_SCAFFOLD: ReadonlyArray<SeedFile> = Object.freeze([
  {
    path: "README.md",
    content:
      "# tellus repository\n\nScaffolded by the typescript-functions template.\n\n## Quick start\n\n```\nnpm install\nnpm run dev\n```\n",
  },
  {
    path: "package.json",
    content: JSON.stringify(
      {
        name: "tellus-repo",
        version: "0.0.1",
        scripts: { dev: "tsc --watch", build: "tsc -p ." },
      },
      null,
      2,
    ),
  },
  { path: "LICENSE", content: "Apache License 2.0\n" },
  {
    path: "src/index.ts",
    content:
      "export { calculateDaysSalesOutstanding } from './functions/calculateDaysSalesOutstanding';\n",
  },
  {
    path: "src/functions/calculateDaysSalesOutstanding.ts",
    content:
      "// @Function decorator placeholder — wired by B8 Functions Registry.\nexport function calculateDaysSalesOutstanding(): number {\n  return 40.51;\n}\n",
  },
  {
    path: "src/functions/index.ts",
    content:
      "export * from './calculateDaysSalesOutstanding';\n",
  },
]);

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
