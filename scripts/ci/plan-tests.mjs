#!/usr/bin/env node
// CI test planner (docs/ci.md). Zero dependencies — runs before `pnpm install`.
//
// Single source of truth: .github/ci/test-selection.json
//
//   node scripts/ci/plan-tests.mjs filters <out-file>
//       Emit the dorny/paths-filter configuration (JSON is valid YAML) derived
//       from the selection config. One filter per category so the planner can
//       classify every changed file with paths-filter's own glob engine.
//   node scripts/ci/plan-tests.mjs list smoke|quarantine
//       Print the smoke / quarantine test files as a JSON array.
//   node scripts/ci/plan-tests.mjs plan
//       env: EVENT_NAME, FORCE_FULL ("true"/"false"),
//            FILTER_OUTPUTS (toJSON(steps.changes.outputs), PR events only)
//       Writes `mode`, `matrix`, `integration`, `extended`, `docker`,
//       `quarantine` to $GITHUB_OUTPUT and a table to $GITHUB_STEP_SUMMARY.
//
// Safety rule: any changed file the config cannot classify forces the FULL
// suite. Selective runs only ever narrow when every file is accounted for.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG_PATH = resolve(ROOT, ".github/ci/test-selection.json");
// Above this many explicitly-changed test files, just run everything.
const MAX_EXPLICIT_FILES = 40;
const SAFE_PATH = /^tests\/[A-Za-z0-9._/@+-]+\.test\.ts$/;
const DOCKER_PATHS = ["Dockerfile*", ".dockerignore", "package.json", "pnpm-lock.yaml", "src/**", "packages/**"];

export function loadConfig(path = CONFIG_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildFilters(cfg) {
  const filters = {
    all: ["**"],
    run_all: cfg.run_all,
    no_tests: cfg.no_tests,
    test_files: ["tests/**/*.test.ts"],
    docker: DOCKER_PATHS,
  };
  for (const [name, g] of Object.entries(cfg.groups)) {
    filters[groupKey(name)] = g.paths;
  }
  return filters;
}

const groupKey = (name) => `group_${name.replace(/[^A-Za-z0-9]/g, "_")}`;

function parseList(outputs, key) {
  const raw = outputs[`${key}_files`];
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function fullMatrix(cfg) {
  const total = cfg.fullShards;
  return Array.from({ length: total }, (_, i) => ({
    name: "full",
    filters: "[]",
    shard: i + 1,
    total,
  }));
}

function groupMatrix(cfg, name) {
  const g = cfg.groups[name];
  const total = Math.max(1, g.shards ?? 1);
  return Array.from({ length: total }, (_, i) => ({
    name,
    filters: JSON.stringify(g.tests),
    shard: i + 1,
    total,
  }));
}

/**
 * Pure planning function (unit-testable): returns the plan and a reasons log.
 */
export function plan(cfg, { eventName, forceFull, outputs }) {
  const reasons = [];
  const full = (why) => {
    reasons.push(`full: ${why}`);
    return {
      mode: "full",
      matrix: fullMatrix(cfg),
      extended: true,
      docker: true,
      quarantine: true,
      groups: ["(all)"],
      reasons,
    };
  };

  if (forceFull) return full("forced (run-full-ci label or workflow_dispatch run_full)");
  if (eventName === "workflow_dispatch") {
    reasons.push("manual run with run_full=false: Tier 1 + smoke only");
    return { mode: "none", matrix: [], extended: false, docker: false, quarantine: false, groups: [], reasons };
  }
  if (eventName !== "pull_request") return full(`event '${eventName}' always runs the full suite`);
  if (!outputs || !outputs.all_files) return full("no change list from paths-filter (fail-safe)");

  const all = parseList(outputs, "all");
  if (all.length === 0) {
    reasons.push("no changed files");
    return { mode: "none", matrix: [], extended: false, docker: false, quarantine: false, groups: [], reasons };
  }

  const noTests = new Set(parseList(outputs, "no_tests"));
  const runAll = new Set(parseList(outputs, "run_all"));
  const testFiles = new Set(parseList(outputs, "test_files"));
  const groupFiles = Object.keys(cfg.groups).map((name) => [name, new Set(parseList(outputs, groupKey(name)))]);

  const selected = new Set();
  const explicit = new Set();
  for (const file of all) {
    if (runAll.has(file)) return full(`'${file}' matches a run_all trigger`);
    if (noTests.has(file)) continue;
    let matched = false;
    for (const [name, set] of groupFiles) {
      if (set.has(file)) {
        selected.add(name);
        matched = true;
      }
    }
    // Test-side files: attribute to the group whose test filters cover them.
    if (!matched && file.startsWith("tests/")) {
      for (const [name, g] of Object.entries(cfg.groups)) {
        if (g.tests.some((t) => file.startsWith(t) || file.includes(t))) {
          selected.add(name);
          matched = true;
        }
      }
    }
    if (!matched && testFiles.has(file)) {
      if (!SAFE_PATH.test(file)) return full(`test file '${file}' has an unexpected path shape`);
      explicit.add(file);
      matched = true;
    }
    if (!matched) return full(`'${file}' is not classified by .github/ci/test-selection.json`);
  }

  if (explicit.size > MAX_EXPLICIT_FILES) return full(`${explicit.size} loose test files changed`);

  const matrix = [];
  for (const name of [...selected].sort()) {
    reasons.push(`group '${name}' selected`);
    matrix.push(...groupMatrix(cfg, name));
  }
  if (explicit.size > 0) {
    reasons.push(`${explicit.size} changed test file(s) run directly`);
    matrix.push({ name: "changed-tests", filters: JSON.stringify([...explicit].sort()), shard: 1, total: 1 });
  }
  const docker = parseList(outputs, "docker").length > 0;
  if (matrix.length === 0) {
    reasons.push("only docs / no-test paths changed");
    return { mode: "none", matrix, extended: false, docker, quarantine: false, groups: [], reasons };
  }
  return {
    mode: "selective",
    matrix,
    extended: false,
    docker,
    quarantine: false,
    groups: [...selected].sort().concat(explicit.size ? ["changed-tests"] : []),
    reasons,
  };
}

function writeOutputs(result) {
  const lines = [
    `mode=${result.mode}`,
    `matrix=${JSON.stringify({ include: result.matrix })}`,
    `integration=${result.matrix.length > 0}`,
    `extended=${result.extended}`,
    `docker=${result.docker}`,
    `quarantine=${result.quarantine}`,
  ];
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  else console.log(lines.join("\n"));

  const summary = [
    "### CI test plan",
    "",
    `| Mode | Groups | Integration jobs | Extended (E2E/perf/test-all) | Docker build |`,
    `|---|---|---|---|---|`,
    `| \`${result.mode}\` | ${result.groups.join(", ") || "—"} | ${result.matrix.length} | ${result.extended} | ${result.docker} |`,
    "",
    ...result.reasons.map((r) => `- ${r}`),
    "",
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  else console.error(summary);
}

function main(argv) {
  const [cmd, arg] = argv;
  const cfg = loadConfig();
  switch (cmd) {
    case "filters": {
      const json = JSON.stringify(buildFilters(cfg), null, 2);
      if (arg) writeFileSync(arg, json + "\n");
      else console.log(json);
      return;
    }
    case "list": {
      if (arg === "smoke") console.log(JSON.stringify(cfg.smoke));
      else if (arg === "quarantine") console.log(JSON.stringify(cfg.quarantine.map((q) => q.file)));
      else throw new Error("usage: list smoke|quarantine");
      return;
    }
    case "plan": {
      let outputs;
      if (process.env.FILTER_OUTPUTS) {
        try {
          outputs = JSON.parse(process.env.FILTER_OUTPUTS);
        } catch {
          outputs = undefined;
        }
      }
      writeOutputs(
        plan(cfg, {
          eventName: process.env.EVENT_NAME ?? "",
          forceFull: process.env.FORCE_FULL === "true",
          outputs,
        }),
      );
      return;
    }
    default:
      throw new Error("usage: plan-tests.mjs filters [out] | list smoke|quarantine | plan");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
