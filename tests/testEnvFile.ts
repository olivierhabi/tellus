// ---------------------------------------------------------------------------
// tests/testEnvFile.ts
//
// File-backed fallback for test-lane secrets. Test code must NEVER bake
// credential literals inline — it reads process.env first, then falls back
// to a value loaded from `.env.test` (local, gitignored) or
// `.env.test.example` (committed template carrying the local-dev defaults
// that match docker-compose-test.yml).
//
// Precedence: process.env > .env.test > .env.test.example > throw.
// Env-first matters: CI provisions lane containers with secret passwords
// (CI_PGPASSWORD) that MUST win over the file defaults.
//
// Deliberately dependency-free (no dotenv import): laneEnv.ts loads before
// any config, in fresh vitest worker processes.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");

let cache: Record<string, string> | null = null;

/** Exported for unit tests (deterministic parser coverage). */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    // Ignore template placeholders with no value (e.g. `API_KEY=`).
    if (value !== "") out[key] = value;
  }
  return out;
}

function loadFiles(): Record<string, string> {
  if (cache) return cache;
  const merged: Record<string, string> = {};
  // Template first (lowest precedence), local overrides on top.
  for (const file of [".env.test.example", ".env.test"]) {
    try {
      mergedAssign(merged, parseEnvFile(fs.readFileSync(path.join(REPO_ROOT, file), "utf8")));
    } catch {
      // Missing file is fine — the other source or process.env covers it.
    }
  }
  cache = merged;
  return merged;
}

function mergedAssign(target: Record<string, string>, src: Record<string, string>): void {
  for (const [k, v] of Object.entries(src)) target[k] = v;
}

/** Raw fallback value from the test env files (undefined when absent). */
export function testEnvFileValue(name: string): string | undefined {
  return loadFiles()[name];
}

/**
 * Resolve a test-lane secret: process.env first, then the test env files.
 * Throws a fail-fast error (never an inline literal) when unresolved.
 */
export function requiredTestSecret(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const fromFile = testEnvFileValue(name);
  if (fromFile) return fromFile;
  throw new Error(
    `${name} is not set and no value was found in .env.test / .env.test.example. ` +
      `Export it or add it to .env.test (see .env.test.example).`,
  );
}
