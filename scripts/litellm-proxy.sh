#!/usr/bin/env bash
# litellm-proxy.sh — start the local LiteLLM proxy (glm-5.2 for Claude
# Code) with startup validation that fails clearly when the required
# secret is absent.
#
# The provider API key is NEVER stored in the repository. Export it
# before launching (or place it in your shell profile / secret manager):
#
#   export LITELLM_GLM_API_KEY="<from the team's secret manager>"
#   ./scripts/litellm-proxy.sh
#
set -euo pipefail

if [[ -z "${LITELLM_GLM_API_KEY:-}" ]]; then
  echo "ERROR: LITELLM_GLM_API_KEY is not set." >&2
  echo "The LiteLLM proxy cannot authenticate to the glm-5.2 provider without it." >&2
  echo "Obtain the key from the team's secret manager and:" >&2
  echo "  export LITELLM_GLM_API_KEY=\"<key>\"" >&2
  exit 1
fi

CONFIG="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/litellm_config.yaml"
exec litellm --config "$CONFIG" "$@"
