#!/usr/bin/env node
/**
 * Production-image smoke for the out-of-process merge engine.
 *
 * Runs INSIDE the built runtime image (see ci.yml docker-build job) against
 * the compiled dist/, with NODE_ENV=production, so it exercises exactly what
 * ships:
 *   1. the production funnel profile selects the out-of-process merge AND the
 *      bundled DuckDB CLI is found and runnable (no silent in-process fallback);
 *   2. the real runDuckDbCliScript spawns the CLI as the non-root app user,
 *      writes/reads parquet with spill under the profile's settings
 *      preamble, and exits 0.
 * Exits non-zero on any deviation.
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runner = require("/app/dist/services/funnel/mergeCliRunner.js");
const { funnelRuntimeConfig } = require("/app/dist/config/funnelRuntime.js");

function fail(msg) {
  console.error(`[docker-merge-cli-smoke] FAIL: ${msg}`);
  process.exit(1);
}

(async () => {
  const cfg = funnelRuntimeConfig();
  if (cfg.profile !== "production") fail(`expected production profile, got ${cfg.profile}`);
  if (!cfg.mergeOutOfProcess) fail("production profile must enable out-of-process merge");

  const decision = await runner.shouldUseOutOfProcessMerge();
  console.log("[docker-merge-cli-smoke] decision:", JSON.stringify(decision));
  if (!decision.outOfProcess) {
    fail(`out-of-process merge not selected in production image (reason=${decision.reason})`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "merge-cli-smoke-"));
  const spill = path.join(work, "spill");
  const out = path.join(work, "out.parquet");
  const rows = 200000;
  const home = path.join(work, "home");
  fs.mkdirSync(home, { recursive: true });
  const preamble = runner.cliSettingsPreamble(runner.resolveCliSettings(spill, home));
  const script = [
    preamble,
    `COPY (SELECT range AS id, 'v' || range::VARCHAR AS v FROM range(${rows})) TO '${out}' (FORMAT parquet);`,
    `SELECT count(*) AS n, count(DISTINCT id) AS d FROM read_parquet('${out}');`,
    "",
  ].join("\n");

  const res = await runner.runDuckDbCliScript({
    scriptText: script,
    workDir: work,
    spillDir: spill,
    watchPaths: [out],
    timeoutMs: 120000,
    stallAfterMs: 60000,
  });
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) fail("parquet output missing/empty");
  const stdout = fs.readFileSync(res.stdoutPath, "utf8");
  const nums = (stdout.match(/\d+/g) || []).map(Number);
  if (!nums.includes(rows)) fail(`row count ${rows} not found in CLI output:\n${stdout}`);
  console.log(`[docker-merge-cli-smoke] OK wallMs=${res.wallMs} rows=${rows}`);
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(0);
})().catch((err) => fail(err && err.stack ? err.stack : String(err)));
