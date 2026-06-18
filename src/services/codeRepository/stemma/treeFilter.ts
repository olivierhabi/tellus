// ---------------------------------------------------------------------------
// B2 — Tree-projection helper (B2-C-10).
//
// Given a flat list of entries (every blob + every directory in the
// branch's tree, with absolute repo-relative paths), return only those
// entries that belong to the directory subtree rooted at `prefix`,
// reaching at most `depth` levels deeper than `prefix`.
//
// `prefix === ""` means repo root. `depth >= 1`. When `depth === 1` the
// caller gets the immediate children of `prefix` only — which is what
// F2-C-02 (lazy folder expansion) needs.
//
// Pure; total; no I/O.
// ---------------------------------------------------------------------------

export interface TreeFilterEntry {
  readonly path: string;
  readonly type: "blob" | "tree";
}

export function projectTree<T extends TreeFilterEntry>(
  entries: readonly T[],
  prefix: string,
  depth: number,
): readonly T[] {
  const root = prefix === "" ? "" : `${prefix}/`;
  const out: T[] = [];
  for (const e of entries) {
    if (e.path === prefix) continue; // exclude the prefix dir itself
    let rel: string;
    if (root === "") {
      rel = e.path;
    } else {
      if (!e.path.startsWith(root)) continue;
      rel = e.path.slice(root.length);
    }
    if (rel.length === 0) continue;
    const segs = rel.split("/").length;
    if (segs <= depth) out.push(e);
  }
  return out;
}

/**
 * Project a flat blob list (paths only) into a tree-shaped entry list,
 * synthesising tree (directory) entries for every distinct ancestor.
 *
 * Used by the in-memory adapter — a real Stemma backend already
 * returns tree objects natively, so this helper is test-only logic
 * but lives here so unit tests can pin the projection invariants
 * directly.
 */
export interface SyntheticTreeEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "blob" | "tree";
  readonly mode: string;
  readonly sha: string;
  readonly size?: number;
}

export interface SyntheticBlobInput {
  readonly path: string;
  readonly mode: string;
  readonly sha: string;
  readonly size: number;
}

export function synthesizeTree(
  blobs: readonly SyntheticBlobInput[],
  dirShaFn: (path: string) => string,
): readonly SyntheticTreeEntry[] {
  const seenDirs = new Set<string>();
  const out: SyntheticTreeEntry[] = [];
  for (const b of blobs) {
    const segs = b.path.split("/");
    for (let i = 1; i < segs.length; i++) {
      const dir = segs.slice(0, i).join("/");
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      out.push({
        name: segs[i - 1],
        path: dir,
        type: "tree",
        mode: "040000",
        sha: dirShaFn(dir),
      });
    }
    out.push({
      name: segs[segs.length - 1],
      path: b.path,
      type: "blob",
      mode: b.mode,
      sha: b.sha,
      size: b.size,
    });
  }
  // Stable order: trees before blobs at the same depth, alphabetically.
  out.sort((a, b) => {
    const da = a.path.split("/").length;
    const db = b.path.split("/").length;
    if (da !== db) return da - db;
    if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return out;
}
