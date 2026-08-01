// ---------------------------------------------------------------------------
// Manifest builder for the evidence tree (audit #5/#6/#9).
//
// Produces <dir>/MANIFEST.json with a sha256 + size + mtime entry per file so
// the committed evidence set is tamper-evident. MANIFEST.json itself is
// excluded. Files are sorted by POSIX-style relative path for stable diffs.
//
// CLI:  tsx scripts/evidence/build-manifest.ts [dir]     (default .migration-evidence)
// Lib:  buildManifest(dir) -> Manifest (pure, no write) — used by unit tests.
// ---------------------------------------------------------------------------

import { execSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface ManifestFileEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
  modifiedAtUtc: string;
}

export interface Manifest {
  schemaVersion: 1;
  generatedAtUtc: string;
  gitCommit: string;
  gitStatus: string;
  files: ManifestFileEntry[];
}

export const MANIFEST_FILENAME = "MANIFEST.json";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue; // skip .DS_Store and friends
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function git(args: string, cwd: string): string {
  try {
    return execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function buildManifest(rootDir: string, nowUtc = new Date().toISOString()): Manifest {
  const abs = path.resolve(rootDir);
  const files: ManifestFileEntry[] = walk(abs)
    .filter((f) => path.basename(f) !== MANIFEST_FILENAME)
    .map((f) => {
      const stat = fs.statSync(f);
      return {
        path: path.relative(abs, f).split(path.sep).join("/"),
        sha256: sha256File(f),
        sizeBytes: stat.size,
        modifiedAtUtc: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    schemaVersion: 1,
    generatedAtUtc: nowUtc,
    gitCommit: git("rev-parse HEAD", abs) || git("rev-parse HEAD", process.cwd()),
    gitStatus: git("status --porcelain", abs) || git("status --porcelain", process.cwd()),
    files,
  };
}

export function writeManifest(rootDir: string): Manifest {
  const manifest = buildManifest(rootDir);
  fs.writeFileSync(path.join(rootDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (require.main === module) {
  const rootDir = process.argv[2] ?? ".migration-evidence";
  const manifest = writeManifest(rootDir);
  console.log(
    `build-manifest: wrote ${path.join(rootDir, MANIFEST_FILENAME)} ` +
      `(${manifest.files.length} files, commit ${manifest.gitCommit.slice(0, 12) || "unknown"})`,
  );
}
