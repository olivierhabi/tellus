#!/usr/bin/env tsx
// ---------------------------------------------------------------------------
// destructive-guard-cli — shell-facing entry to destructiveTestGuard.
//
// Usage:
//   tsx scripts/destructive-guard-cli.ts --operation <name> [--skip-api-probe]
//
// Exit 0 + JSON proof on stdout  → the environment is a provably isolated
// test/verify stack; the destructive operation may proceed.
// Exit 1 + JSON {error, reasonCode, field} on stderr → refuse.
// ---------------------------------------------------------------------------

import {
  assertDestructiveTestEnvironment,
  DestructiveTestEnvironmentError,
} from "../src/services/testing/destructiveTestGuard";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opIdx = args.indexOf("--operation");
  const operation = opIdx >= 0 ? args[opIdx + 1] : "shell-script";
  const skipApiProbe = args.includes("--skip-api-probe");
  try {
    const proof = await assertDestructiveTestEnvironment({
      operation,
      skipApiProbe,
    });
    process.stdout.write(JSON.stringify({ ok: true, proof }) + "\n");
    process.exit(0);
  } catch (err) {
    if (err instanceof DestructiveTestEnvironmentError) {
      process.stderr.write(
        JSON.stringify({
          ok: false,
          error: err.message,
          reasonCode: err.reasonCode,
          field: err.field ?? null,
        }) + "\n",
      );
    } else {
      process.stderr.write(
        JSON.stringify({ ok: false, error: (err as Error).message }) + "\n",
      );
    }
    process.exit(1);
  }
}

void main().finally(() => process.exit(0));
