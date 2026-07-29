# AI contract CI job — administrator setup

> Consolidated into **`docs/ops/administrator-handoff.md` §B** —
> the handoff is the canonical checklist; this file retains the
> technical detail.

**Status:** job defined in `.github/workflows/ci.yml` (`ai-contract`),
but **no actual workflow run exists yet**. This is an external
administrative blocker — the CI gate must be reported BLOCKED until a
real run is produced.

## Why it cannot run today

1. **No reachable engine.** The job needs an AI engine
   (telos-AIE-agent) reachable from GitHub-hosted runners. The only
   configured instance is `http://127.0.0.1:5000` (`.env.example:166`)
   — localhost. GitHub-hosted runners cannot reach it. A deployed
   (staging/prod) engine URL does not exist in any deployment config.
2. **Provider credentials live in the engine's environment.** The
   Gemini API key(s) must be present in the DEPLOYED engine's
   environment (`GEMINI_API_KEY` / `LLM_API_KEY` / `LLM_BASE_URL` —
   names only; values never in the repo or CI secrets for tellus).
3. **The workflow change is not pushed.** The `ai-contract` job exists
   only in the working tree; the working tree contains multiple
   workstreams, so what gets committed/pushed is a repo-owner
   decision.

## Exact required configuration (repo admin)

Repository **variables** (`gh variable set` / Settings → Variables):

| Name | Value | Notes |
|---|---|---|
| `AI_CONTRACT_TEST_ENABLED` | `1` | gates the job (`if:` condition) |
| `TELOS_AIE_AGENT_URL` | `https://<deployed-engine>` | must be reachable from GitHub-hosted runners; must serve `GET /api/models` |

Repository **secrets** (`gh secret set` / Settings → Secrets):

| Name | Required? | Notes |
|---|---|---|
| `TELOS_AIE_AGENT_TOKEN` | only if the deployed engine enforces auth | forwarded as-is; tellus passes it through |

Engine-side (NOT in this repo):

| Name | Notes |
|---|---|
| `GEMINI_API_KEY` (or `LLM_API_KEY`+`LLM_BASE_URL`) | provider credentials for `gemini-2.5-flash` and `gemini-3.1-flash-lite`. **No glm-5.2 entitlement or credential is required** — glm-5.2 is excluded from the supported edit-generation set. |

## Triggering and required evidence

Once the above are set and the commit containing the `ai-contract`
job is pushed:

```
gh workflow run ci.yml --ref <branch>
gh run list --workflow=ci.yml --limit 1
```

A passing closeout requires recording:

- workflow run identifier (`gh run view <id>`),
- commit SHA,
- job name `ai-contract`,
- per-model results for BOTH `gemini-2.5-flash` and
  `gemini-3.1-flash-lite` (generation → publish → registry
  `functionKind === "edit"` → sandbox execution),
- evidence the job was not skipped (job status `success`, not
  `skipped`).

If GitHub-hosted runners cannot reach the engine permanently, the
alternative is a **self-hosted runner** on a host that can reach the
engine; the job needs no other changes.
