#!/usr/bin/env node
// Weekly CI effectiveness report (docs/ci.md). Read-only: uses `gh api` with
// the workflow's GITHUB_TOKEN (actions: read, pull-requests: read).
//
// Answers "is test selection too aggressive or too conservative?":
//   * failures per tier       Tier 2 = ci.yml pull_request, Tier 3 = ci.yml
//                             merge_group (+ push), Tier 4 = nightly.yml
//   * escaped failures        a later tier failed although the earlier tier
//                             was green for the same change:
//                               - merge_group / push failed while the PR's
//                                 head SHA had a green pull_request CI run
//                               - nightly failed on a SHA whose push /
//                                 merge_group CI run was green
//   * escaped-failure rate    escapes / later-tier runs evaluated
//   * PR full-run fraction    share of PR runs that ran the 8-shard suite
//
// env: GITHUB_REPOSITORY (owner/repo), DAYS (default 7), OUT (json path),
//      GITHUB_STEP_SUMMARY (optional), MAX_JOB_LOOKUPS (default 150)
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const REPO = process.env.GITHUB_REPOSITORY;
if (!REPO) throw new Error("GITHUB_REPOSITORY is required");
const DAYS = Number(process.env.DAYS || 7);
const MAX_JOB_LOOKUPS = Number(process.env.MAX_JOB_LOOKUPS || 150);
const OUT = process.env.OUT || "ci-effectiveness.json";
const AGGRESSIVE_THRESHOLD = 0.05;

const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

function gh(path, jq) {
  const args = ["api", "-H", "Accept: application/vnd.github+json", "--paginate", path];
  if (jq) args.push("--jq", jq);
  const out = execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function ghOne(path) {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
}

const runFields = "{id, event, conclusion, status, head_sha, head_branch, run_started_at, updated_at, html_url}";
const listRuns = (workflow, extra = "") =>
  gh(`repos/${REPO}/actions/workflows/${workflow}/runs?per_page=100&created=%3E%3D${since}${extra}`, `.workflow_runs[] | ${runFields}`)
    .filter((r) => r.status === "completed");

function workflowExists(file) {
  try {
    ghOne(`repos/${REPO}/actions/workflows/${file}`);
    return true;
  } catch {
    return false;
  }
}

const minutes = (r) => (Date.parse(r.updated_at) - Date.parse(r.run_started_at)) / 60_000;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Number((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(1));
};

function tierStats(runs) {
  const failed = runs.filter((r) => r.conclusion === "failure");
  return {
    runs: runs.length,
    success: runs.filter((r) => r.conclusion === "success").length,
    failure: failed.length,
    cancelled: runs.filter((r) => r.conclusion === "cancelled").length,
    failureRate: runs.length ? Number((failed.length / runs.length).toFixed(3)) : null,
    medianMinutes: median(runs.map(minutes)),
  };
}

const prGreenCache = new Map();
function prHeadWasGreen(prNumber) {
  if (prGreenCache.has(prNumber)) return prGreenCache.get(prNumber);
  let green = false;
  try {
    const pr = ghOne(`repos/${REPO}/pulls/${prNumber}`);
    const runs = gh(
      `repos/${REPO}/actions/workflows/ci.yml/runs?per_page=100&event=pull_request&head_sha=${pr.head.sha}`,
      `.workflow_runs[] | ${runFields}`,
    );
    green = runs.some((r) => r.conclusion === "success");
  } catch {
    green = false;
  }
  prGreenCache.set(prNumber, green);
  return green;
}

function prForRun(run) {
  if (run.event === "merge_group") {
    const m = /^gh-readonly-queue\/[^/]+(?:\/[^/]+)*\/pr-(\d+)-/.exec(run.head_branch || "");
    return m ? Number(m[1]) : null;
  }
  try {
    const pulls = ghOne(`repos/${REPO}/commits/${run.head_sha}/pulls`);
    const merged = pulls.find((p) => p.merged_at) || pulls[0];
    return merged ? merged.number : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
const ciRuns = listRuns("ci.yml");
const prRuns = ciRuns.filter((r) => r.event === "pull_request");
const mqRuns = ciRuns.filter((r) => r.event === "merge_group");
const pushRuns = ciRuns.filter((r) => r.event === "push");
const nightlyRuns = workflowExists("nightly.yml")
  ? listRuns("nightly.yml").filter((r) => r.event === "schedule" || r.event === "workflow_dispatch")
  : [];

// Tier 2 escapes into Tier 3 (merge queue) or post-merge push.
const escapes = [];
let laterEvaluated = 0;
for (const run of [...mqRuns, ...pushRuns]) {
  if (run.conclusion !== "success" && run.conclusion !== "failure") continue;
  const pr = prForRun(run);
  if (!pr || !prHeadWasGreen(pr)) continue;
  laterEvaluated++;
  if (run.conclusion === "failure") escapes.push({ from: "pull_request", caughtBy: run.event, pr, run: run.html_url });
}

// Tier 3 escapes into Tier 4 (nightly).
const greenFullShas = new Set(
  [...mqRuns, ...pushRuns].filter((r) => r.conclusion === "success").map((r) => r.head_sha),
);
let nightlyEvaluated = 0;
for (const run of nightlyRuns) {
  if (!greenFullShas.has(run.head_sha)) continue;
  nightlyEvaluated++;
  if (run.conclusion === "failure") escapes.push({ from: "merge_group/push", caughtBy: "nightly", sha: run.head_sha, run: run.html_url });
}

// Fraction of PR runs that ran the full suite (Tier 2 → full fallback or Tier 5).
let fullPr = 0;
let looked = 0;
for (const run of prRuns.slice(0, MAX_JOB_LOOKUPS)) {
  looked++;
  const names = gh(`repos/${REPO}/actions/runs/${run.id}/jobs?per_page=100`, ".jobs[].name");
  if (names.some((n) => /Integration \(full /.test(n))) fullPr++;
}
const fullFraction = looked ? Number((fullPr / looked).toFixed(3)) : null;

const tier2Escapes = escapes.filter((e) => e.from === "pull_request").length;
const escapeRate = laterEvaluated ? Number((tier2Escapes / laterEvaluated).toFixed(3)) : null;

let recommendation;
if (escapeRate === null || laterEvaluated < 10) {
  recommendation = `Not enough data yet (${laterEvaluated} merge-queue/post-merge runs with a green PR run; need ≥ 10). Keep the current selection.`;
} else if (escapeRate > AGGRESSIVE_THRESHOLD) {
  recommendation = `Selection looks TOO AGGRESSIVE: ${(escapeRate * 100).toFixed(1)}% of green PRs failed later (threshold ${AGGRESSIVE_THRESHOLD * 100}%). Inspect the escapes below, then widen the matching group's \`paths\`/\`tests\` or add the path to \`run_all\` in .github/ci/test-selection.json.`;
} else if (escapeRate === 0 && fullFraction !== null && fullFraction > 0.5) {
  recommendation = `Selection looks TOO CONSERVATIVE: zero escapes, but ${(fullFraction * 100).toFixed(0)}% of PR runs fell back to the full suite. Consider narrowing \`run_all\` or adding groups for frequently-touched paths.`;
} else {
  recommendation = `Selection looks balanced: escaped-failure rate ${(escapeRate * 100).toFixed(1)}% (≤ ${AGGRESSIVE_THRESHOLD * 100}%), PR full-run fraction ${fullFraction === null ? "n/a" : (fullFraction * 100).toFixed(0) + "%"}.`;
}

const report = {
  repo: REPO,
  windowDays: DAYS,
  since,
  tiers: {
    "tier2-pull_request": tierStats(prRuns),
    "tier3-merge_group": tierStats(mqRuns),
    "post-merge-push": tierStats(pushRuns),
    "tier4-nightly": tierStats(nightlyRuns),
  },
  escapes,
  escapedFailureRate: escapeRate,
  laterTierRunsEvaluated: laterEvaluated,
  nightlyRunsEvaluated: nightlyEvaluated,
  prFullRunFraction: fullFraction,
  prRunsInspected: looked,
  recommendation,
};
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");

const fmt = (v) => (v === null || v === undefined ? "—" : String(v));
const md = [
  `## CI effectiveness — last ${DAYS} days (since ${since})`,
  "",
  "| Tier | Runs | Success | Failure | Cancelled | Failure rate | Median min |",
  "|---|---|---|---|---|---|---|",
  ...Object.entries(report.tiers).map(
    ([k, s]) => `| ${k} | ${s.runs} | ${s.success} | ${s.failure} | ${s.cancelled} | ${fmt(s.failureRate)} | ${fmt(s.medianMinutes)} |`,
  ),
  "",
  `- Escaped-failure rate (PR green → later tier red): **${escapeRate === null ? "n/a" : (escapeRate * 100).toFixed(1) + "%"}** (${tier2Escapes}/${laterEvaluated})`,
  `- Nightly escapes (MQ/push green → nightly red): ${escapes.filter((e) => e.caughtBy === "nightly").length}/${nightlyEvaluated}`,
  `- PR runs that ran the full suite: ${fullFraction === null ? "n/a" : (fullFraction * 100).toFixed(0) + "%"} (${fullPr}/${looked})`,
  "",
  `**Recommendation:** ${recommendation}`,
  "",
  ...(escapes.length ? ["### Escapes", "", ...escapes.map((e) => `- ${e.caughtBy} caught a ${e.from} miss${e.pr ? ` (PR #${e.pr})` : ""}: ${e.run}`)] : []),
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md);
