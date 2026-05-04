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
}

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
