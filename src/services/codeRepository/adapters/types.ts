// ---------------------------------------------------------------------------
// B2 — adapter interfaces for the createRepository saga.
//
// Each adapter has both a real implementation (HTTP/SQL backed) and a
// test-mode in-memory implementation. The saga executor depends only on
// these interfaces — adapter-swap is a constructor argument, not a
// runtime branch.
//
// Three adapters:
//   1. CompassAdapter      — reserve/release a folder name reservation
//   2. StemmaAdapter       — create/tombstone a git store
//   3. TemplateAdapter     — scaffold + push initial commit (B3)
//
// All three are compensable. Compensation calls MUST be idempotent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compass adapter — folder-level resource reservation.
// ---------------------------------------------------------------------------

export interface CompassReserveArgs {
  readonly displayName: string;
  readonly parentFolderRid: string;
  readonly principalSub: string;
  /** RID minted upstream so reserve+release can be idempotent. */
  readonly proposedRid: string;
}

export type CompassReserveOutcome =
  | { kind: "ok"; resourceRid: string; projectRid: string }
  | { kind: "name-conflict" }
  | { kind: "parent-not-found" }
  | { kind: "permission-denied" }
  | { kind: "transient"; reason: string };

export interface CompassAdapter {
  reserve(args: CompassReserveArgs): Promise<CompassReserveOutcome>;
  /** Release a reservation. MUST be idempotent — release-twice is OK. */
  release(args: { resourceRid: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Stemma adapter — git store creation/tombstone.
// ---------------------------------------------------------------------------

export interface StemmaCreateArgs {
  readonly proposedRid: string;
  readonly defaultBranchName: string;
  readonly principalSub: string;
}

export type StemmaCreateOutcome =
  | { kind: "ok"; repositoryRid: string }
  | { kind: "transient"; reason: string };

export interface StemmaAdapter {
  createRepository(args: StemmaCreateArgs): Promise<StemmaCreateOutcome>;
  /** Tombstone (soft-delete). MUST be idempotent. */
  tombstone(args: { repositoryRid: string }): Promise<void>;
  // -----------------------------------------------------------------------
  // B2-C-10 / B2-C-11 — read paths.
  //
  // The createRepository saga is unchanged; these methods extend the
  // interface so the in-memory adapter (and a future real-Stemma adapter)
  // can serve the file-tree and file-content endpoints without forking
  // adapter wiring. Both methods are total + idempotent.
  // -----------------------------------------------------------------------
  listTree(args: StemmaListTreeArgs): Promise<StemmaListTreeOutcome>;
  readBlob(args: StemmaReadBlobArgs): Promise<StemmaReadBlobOutcome>;
  // -----------------------------------------------------------------------
  // B3 → Stemma write path.
  //
  // Used by the Templates Engine to commit a scaffold into a freshly-created
  // bare repo on its default branch. The saga calls `createRepository` to
  // mint the empty repo, then `template.scaffoldAndPush` to push the
  // template's file list — the template adapter calls back through this
  // method.
  //
  // Idempotency: callers are expected to commit a deterministic file set;
  // re-issuing the same commit against an already-populated branch
  // overwrites the head (no merge semantics — this is the in-memory
  // analogue of `git push --force` for a freshly-scaffolded repo). Real
  // Stemma deployments enforce the standard CAS contract via ref updates.
  // -----------------------------------------------------------------------
  commitFiles(args: StemmaCommitFilesArgs): Promise<StemmaCommitFilesOutcome>;
}

/** A file to commit. `content` carries raw bytes — binary-safe. */
export interface StemmaCommitFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: "100644" | "100755";
}

export interface StemmaCommitFilesArgs {
  readonly repositoryRid: string;
  readonly branch: string;
  /**
   * Files to add or modify (upsert). The blob at each `path` is set to
   * `content` regardless of whether the path existed previously. This is
   * the only field consumed by the legacy template-scaffold path.
   */
  readonly files: ReadonlyArray<StemmaCommitFile>;
  /**
   * Optional list of repo-relative paths to remove from the tree as part
   * of the same commit. Unknown paths are tolerated (idempotent delete);
   * the adapter does NOT 404 on missing paths. Empty / omitted ⇒ no
   * deletes. Must NOT overlap with any path in `files` — adapter rejects
   * with `transient: "delete-overlaps-upsert"` if violated.
   */
  readonly deletePaths?: ReadonlyArray<string>;
  /**
   * Optional CAS fence: if provided, the adapter MUST reject the commit
   * with `kind: "stale-ref"` when the branch's current HEAD does not
   * equal `parentSha`. When omitted the commit always fast-forwards
   * (legacy template-scaffold semantics — the bare repo just received
   * `createRepository` and we want to stamp the initial scaffold).
   *
   * Real-Stemma deployments translate this into a JGit `RefUpdate.update`
   * with `setExpectedOldObjectId(parentSha)` so CAS is enforced under
   * the same lock as the ref write.
   */
  readonly parentSha?: string;
  readonly message: string;
  readonly principalSub: string;
}

export type StemmaCommitFilesOutcome =
  | {
      kind: "ok";
      commitSha: string;
      fileCount: number;
      totalBytes: number;
    }
  | { kind: "branch-not-found" }
  | {
      /**
       * `parentSha` was provided and did not equal the branch's current
       * HEAD at commit time. `currentHead` is the HEAD as observed by the
       * adapter under its serializing lock — the route surfaces this back
       * to the client so the IDE can resync without re-querying.
       */
      kind: "stale-ref";
      expectedSha: string;
      currentHead: string;
    }
  | { kind: "transient"; reason: string };

/** A flattened tree entry. `path` is repo-root-relative. */
export interface StemmaTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "blob" | "tree";
  readonly mode: string;
  readonly sha: string;
  readonly size?: number;
}

export interface StemmaListTreeArgs {
  readonly repositoryRid: string;
  readonly branch: string;
  /** Pre-validated repo-relative path. "" === root. */
  readonly path: string;
  /** 1..5. */
  readonly depth: number;
}

export type StemmaListTreeOutcome =
  | {
      kind: "ok";
      entries: readonly StemmaTreeEntry[];
      truncated: boolean;
      branchHead: string;
      /** Stable hash over the projected entries — used as ETag. */
      treeSha: string;
    }
  | { kind: "branch-not-found" }
  | { kind: "path-not-found" }
  | { kind: "transient"; reason: string };

export interface StemmaReadBlobArgs {
  readonly repositoryRid: string;
  readonly branch: string;
  readonly path: string;
}

export type StemmaReadBlobOutcome =
  | {
      kind: "ok";
      content: Uint8Array;
      sha: string;
      size: number;
    }
  | { kind: "branch-not-found" }
  | { kind: "path-not-found" }
  | { kind: "path-is-tree" }
  | { kind: "transient"; reason: string };

// ---------------------------------------------------------------------------
// Template adapter — scaffold + push initial commit.
// ---------------------------------------------------------------------------

export interface TemplateScaffoldArgs {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly repositoryRid: string;
  readonly principalSub: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly targetBranch: string;
}

export type TemplateScaffoldOutcome =
  | {
      kind: "ok";
      commitSha: string;
      fileCount: number;
      totalBytes: number;
    }
  | { kind: "template-not-found"; templateId: string; version: string }
  | { kind: "init-failed"; reason: string };

export interface TemplateAdapter {
  scaffoldAndPush(
    args: TemplateScaffoldArgs,
  ): Promise<TemplateScaffoldOutcome>;
}
