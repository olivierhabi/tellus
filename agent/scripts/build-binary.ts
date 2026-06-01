#!/usr/bin/env node
// ---------------------------------------------------------------------------
// B6 — Build single-binary distribution via `pkg` (spec §B6 line 309).
//
// Invoked as `npm run build:binary` from agent/. Compiles TS via `tsc` then
// invokes `pkg` to produce node20-linux-x64 and node20-macos-x64 binaries in
// agent/build/.
//
// Functional binary test on Linux x64 satisfies criterion 1.
// Cosign signing is deferred (DEFERRED.md).
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) {
    // eslint-disable-next-line no-console
    console.error(`${cmd} ${args.join(" ")} -> exit ${r.status}`);
    process.exit(r.status ?? 1);
  }
}

function main(): void {
  if (!existsSync("dist/bootvisor.js")) {
    run("npx", ["tsc", "-p", "tsconfig.json"]);
  }
  run("npx", ["pkg", "."]);
  // eslint-disable-next-line no-console
  console.log("[build-binary] artifacts in agent/build/");
}

main();
