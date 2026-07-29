# LiteLLM credential exposure — rotation instructions

> Consolidated into **`docs/ops/administrator-handoff.md` §A** —
> the handoff is the canonical checklist; this file retains the
> technical detail.

**Status:** REMEDIATED in the working tree; **rotation is an external
administrator action and remains OPEN until confirmed.**

## What happened

`litellm_config.yaml` contained a hardcoded provider API key for the
glm-5.2 LiteLLM proxy (Aliyun MaaS endpoint). It was committed in
`dd0ea16` (2026-06-28, "continue workshop and code repositories") and
**pushed to `origin` (github.com:olivierhabi/tellus) on branch
`fixing-code-repository`**. Because the value reached a remote host,
it must be treated as **compromised** regardless of repo visibility.

## Remediation applied (this pass)

- `litellm_config.yaml`: the literal key is replaced by
  `api_key: os.environ/LITELLM_GLM_API_KEY` (LiteLLM's native
  environment substitution).
- `scripts/litellm-proxy.sh`: launcher with startup validation —
  exits 1 with a clear message when `LITELLM_GLM_API_KEY` is unset.
- CI: a `secret-scan` job (gitleaks) now scans PR/push commits so a
  new credential cannot be introduced silently.

## Required administrator actions (in order)

1. **REVOKE / ROTATE the exposed key** at the provider console
   (Aliyun MaaS / DashScope workspace `ws-8p464sqf20yfd2f2`).
   Until this is done the old value remains usable by anyone who
   cloned the repo or saw the history.
2. Store the NEW key in the team's secret manager; distribute via
   `export LITELLM_GLM_API_KEY=...` — never commit it.
3. Decide on **history remediation**: because the key is rotated in
   step 1, scrubbing history (BFG / `git filter-repo` + force push of
   `fixing-code-repository` and any branch containing `dd0ea16`) is
   optional but recommended; it requires coordinating with anyone who
   has local clones.
4. Confirm rotation back to the team so this file can be marked
   CLOSED.

## Verification performed

- Working tree: `grep -c "sk-" litellm_config.yaml` → 0.
- Launcher without the env var: prints the ERROR block, exit 1.
- `ci.yml` parses (YAML OK) with the new job.
