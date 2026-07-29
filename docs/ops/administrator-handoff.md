# Administrator handoff — Phases 1–5 closeout

**Purpose:** the exact external actions still required before this
work can be released. Engineering remediation is complete; every
item below needs an administrator (provider console, repo settings,
or deployment policy). Detail docs:
`docs/security/litellm-credential-rotation.md`,
`docs/ops/ai-contract-ci-setup.md`,
`docs/sandbox-isolation-migration-plan.md`,
`docs/sandbox-privileged-operations-matrix.md`.

---

## A. Credential rotation — REQUIRED FIRST (treat as compromised)

- **Provider / credential:** Aliyun MaaS (DashScope-compatible
  endpoint, workspace `ws-8p464sqf20yfd2f2`, cn-hongkong) — the API
  key previously hardcoded in `litellm_config.yaml` for the local
  LiteLLM glm-5.2 proxy. The value is intentionally not printed
  here.
- **Why compromised:** the key existed in pushed Git history
  (commit `dd0ea16`, 2026-06-28, branch `fixing-code-repository` on
  `github.com:olivierhabi/tellus`) and appeared once in an AI
  session transcript.
- [ ] **Revoke/rotate at the provider:** Aliyun console → the
  workspace's API-KEY management → delete/regenerate the exposed
  key.
- [ ] **Update the deployment secret:** store the new key in the
  team secret manager; developers consume it via
  `export LITELLM_GLM_API_KEY=...` and
  `scripts/litellm-proxy.sh` (fails closed when unset). The repo
  now references only `os.environ/LITELLM_GLM_API_KEY`.
- [ ] **Verify the old credential no longer works:** call the
  provider endpoint with the OLD key (from history) — expect
  401/403.
- [ ] **Verify the new credential works:**
  `LITELLM_GLM_API_KEY=<new> ./scripts/litellm-proxy.sh` and
  complete one proxied request.
- [ ] **Git history:** provider-side revocation is SUFFICIENT once
  confirmed (the old value is then dead everywhere). History
  rewriting (BFG / `git filter-repo` + force-push of every branch
  containing `dd0ea16`) is RECOMMENDED hygiene but optional;
  coordinate with anyone holding local clones.
- [ ] **Rotation recorded:** date __________ administrator
  __________
- CI already includes a `secret-scan` (gitleaks) job to prevent
  recurrence.

---

## B. AI contract CI — release-gate decision required

The `ai-contract` job is defined in `.github/workflows/ci.yml` but
has never executed (no run ID exists). Required:

- [ ] **Reachable deployed AI-engine URL** — a telos-AIE-agent
  deployment reachable from GitHub-hosted runners (today only
  `http://127.0.0.1:5000` exists). Alternative: a self-hosted
  runner on a host that can reach the engine.
- [ ] **Repo variable** `AI_CONTRACT_TEST_ENABLED=1`.
- [ ] **Repo variable** `TELOS_AIE_AGENT_URL=https://<deployed-engine>`.
- [ ] **Repo secret** `TELOS_AIE_AGENT_TOKEN` — only if the
  deployed engine enforces auth.
- [ ] **Engine-side Gemini provider credentials**
  (`GEMINI_API_KEY` or `LLM_API_KEY`+`LLM_BASE_URL`) for
  `gemini-2.5-flash` and `gemini-3.1-flash-lite`.
  **glm-5.2 is excluded from the supported edit-generation model
  set** (this deployment's provider account has no entitlement);
  do not add it to the matrix.
- [ ] **Push the branch/commit containing the workflow job** (the
  working tree mixes workstreams — repo-owner decision what lands).
- [ ] **Trigger:** `gh workflow run ci.yml --ref <branch>` (or a
  normal push to a branch the workflow runs on).
- [ ] **Record the required evidence:** workflow run ID, commit
  SHA, job `ai-contract` status `success` (NOT `skipped`), and
  per-model results showing BOTH `gemini-2.5-flash` and
  `gemini-3.1-flash-lite` passing generation → publish →
  `functionKind="edit"` → sandbox execution.

Until that run exists, CI contract enforcement is BLOCKED. Whether
this blocks release is an organizational policy decision (see §D).

---

## C. Multi-tenant isolation — deployment constraint

**Production deployment must remain single-tenant (or otherwise
trusted-user-only) until the isolation migration is complete and
reviewed.** The current sandbox is an incremental hardening pass,
not a security boundary (see
`docs/sandbox-privileged-operations-matrix.md` for what is and is
not mediated).

Migration plan: `docs/sandbox-isolation-migration-plan.md`.
Minimum acceptance conditions for lifting this constraint:

- [ ] Host-realm escape removed (isolate-based execution cell; the
  `vm` context escape class eliminated by construction).
- [ ] Privileged operations mediated outside the sandbox (broker
  protocol; sandbox cannot self-grant).
- [ ] Per-function and publisher authorization enforced at the
  broker.
- [ ] Per-principal read authorization (today: per-declared-import
  only; no per-user row-level security).
- [ ] Network and filesystem policy (deny-by-default inside the
  execution cell; any allow via broker).
- [ ] Worker memory and CPU enforcement verified in production
  configuration.
- [ ] Isolation-boundary security review (external or security
  team sign-off).
- [ ] Adversarial escape testing (known vm/isolate escape corpus).
- [ ] Production compiled-worker verification rerun against the
  isolated runtime.

---

## D. Deployment recommendation

- **Permitted for controlled single-tenant production or trusted
  internal deployment after credential rotation.** (Section A
  complete and verified is the precondition.)
- **Not approved for untrusted multi-tenant production.** This
  remains true until Section C is completed and reviewed.
- **CI contract execution (Section B)** may be an organizational
  release blocker depending on deployment policy. The engineering
  team does not choose this: if the organization's release policy
  requires CI-enforced model contracts, release waits for the
  first green `ai-contract` run; if local contract evidence is
  accepted for this release, document that decision explicitly.
