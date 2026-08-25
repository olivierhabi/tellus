#!/usr/bin/env bash
# =============================================================================
# k8s-local-down.sh — tear down the stack started by k8s-local-up.sh.
#
# Usage:
#   ./scripts/k8s-local-down.sh              # helm uninstall + delete ns
#   ./scripts/k8s-local-down.sh --cluster    # also delete kind/k3d cluster
#   ./scripts/k8s-local-down.sh --yes        # no confirmation for --cluster
#   ./scripts/k8s-local-down.sh -h
#
# Env: PROVIDER, CLUSTER_NAME, NAMESPACE, RELEASE_NAME
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"
cd -- "$REPO_ROOT"

PROVIDER="${PROVIDER:-kind}"
CLUSTER_NAME="${CLUSTER_NAME:-tellus-local}"
NAMESPACE="${NAMESPACE:-tenant-local}"
RELEASE_NAME="${RELEASE_NAME:-tellus-local}"

DELETE_CLUSTER=0
ASSUME_YES=0

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RST=$'\033[0m'; C_INF=$'\033[36m'; C_OK=$'\033[32m'; C_WRN=$'\033[33m'; C_ERR=$'\033[31m'
else
  C_RST=""; C_INF=""; C_OK=""; C_WRN=""; C_ERR=""
fi
ts()   { date +'%H:%M:%S'; }
log()  { printf '%s %s[k8s]%s %s\n' "$(ts)" "$C_INF" "$C_RST" "$*"; }
ok()   { printf '%s %s[ ok]%s %s\n' "$(ts)" "$C_OK"  "$C_RST" "$*"; }
warn() { printf '%s %s[warn]%s %s\n' "$(ts)" "$C_WRN" "$C_RST" "$*" >&2; }
die()  { printf '%s %s[err]%s %s\n' "$(ts)" "$C_ERR" "$C_RST" "$*" >&2; exit 1; }

usage() { sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cluster) DELETE_CLUSTER=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    --provider) PROVIDER="${2:-}"; shift ;;
    --provider=*) PROVIDER="${1#*=}" ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

if ! command -v kubectl >/dev/null 2>&1; then
  die "kubectl not found"
fi

# Best-effort context switch if the cluster still exists.
case "$PROVIDER" in
  kind)
    if command -v kind >/dev/null 2>&1 && kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
      kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null 2>&1 || true
    fi
    ;;
  k3d)
    if command -v k3d >/dev/null 2>&1 && k3d cluster list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$CLUSTER_NAME"; then
      kubectl config use-context "k3d-${CLUSTER_NAME}" >/dev/null 2>&1 || true
    fi
    ;;
esac

if command -v helm >/dev/null 2>&1; then
  if helm status "$RELEASE_NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
    log "helm uninstall ${RELEASE_NAME} -n ${NAMESPACE}"
    helm uninstall "$RELEASE_NAME" -n "$NAMESPACE" --wait --timeout 3m || warn "helm uninstall had issues"
    ok "helm release removed"
  else
    log "no helm release ${RELEASE_NAME} in ${NAMESPACE}"
  fi
fi

if kubectl get ns "$NAMESPACE" >/dev/null 2>&1; then
  log "deleting namespace ${NAMESPACE} (pods + PVCs)…"
  kubectl delete ns "$NAMESPACE" --wait=true --timeout=180s || warn "namespace delete timed out"
  ok "namespace deleted"
else
  log "namespace ${NAMESPACE} already gone"
fi

if [[ "$DELETE_CLUSTER" -eq 1 ]]; then
  if [[ "$ASSUME_YES" -ne 1 ]]; then
    warn "This will DELETE the entire ${PROVIDER} cluster '${CLUSTER_NAME}'."
    read -r -p "Type 'yes' to continue: " ans
    [[ "$ans" == "yes" ]] || die "aborted"
  fi
  case "$PROVIDER" in
    kind)
      command -v kind >/dev/null 2>&1 || die "kind not found"
      kind delete cluster --name "$CLUSTER_NAME"
      ;;
    k3d)
      command -v k3d >/dev/null 2>&1 || die "k3d not found"
      k3d cluster delete "$CLUSTER_NAME"
      ;;
    *) die "unknown PROVIDER=$PROVIDER" ;;
  esac
  ok "cluster ${CLUSTER_NAME} deleted"
fi

ok "local Kubernetes stack stopped"
