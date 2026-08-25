#!/usr/bin/env bash
# =============================================================================
# k8s-local-up.sh — Kubernetes analog of ./run.sh for a minimal Tellus stack.
#
# Production-shaped local path (kind or k3d):
#   1. Preflight tooling + Docker
#   2. Create (or reuse) a local cluster
#   3. Build the Tellus app image (Dockerfile)
#   4. Load the image into the cluster nodes
#   5. Apply hardened dependency manifests (Postgres, MinIO, OpenSearch, Redis)
#   6. Helm install/upgrade the tellus-tenant chart (probes, SA, NP, quotas)
#   7. Gate on Deployment Available + HTTP readiness
#   8. Print endpoints + kubectl cheatsheet
#
# Usage:
#   ./scripts/k8s-local-up.sh                 # full path (kind default)
#   ./scripts/k8s-local-up.sh --provider k3d
#   ./scripts/k8s-local-up.sh --no-build      # reuse existing image tag
#   ./scripts/k8s-local-up.sh --recreate      # delete cluster first
#   ./scripts/k8s-local-up.sh --skip-deps     # only re-helm the app
#   ./scripts/k8s-local-up.sh --no-wait
#   ./scripts/k8s-local-up.sh --hpa          # install metrics-server + enable HPA
#   ./scripts/k8s-local-up.sh -h | --help
#
# Overridable via env:
#   PROVIDER, CLUSTER_NAME, IMAGE_REPO, IMAGE_TAG, NAMESPACE, RELEASE_NAME,
#   HEALTH_TIMEOUT, HELM_TIMEOUT, BUILD_CONTEXT, DOCKERFILE, VALUES_FILE,
#   SKIP_COMPOSE_WARN, REPLICAS
#
# Tear down with: ./scripts/k8s-local-down.sh
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"
cd -- "$REPO_ROOT"

# --- configuration -----------------------------------------------------------
PROVIDER="${PROVIDER:-kind}"                 # kind | k3d
CLUSTER_NAME="${CLUSTER_NAME:-tellus-local}"
IMAGE_REPO="${IMAGE_REPO:-tellus/app}"
IMAGE_TAG="${IMAGE_TAG:-local}"
NAMESPACE="${NAMESPACE:-tenant-local}"
RELEASE_NAME="${RELEASE_NAME:-tellus-local}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-420}"      # cold OS + migrations on laptop
HELM_TIMEOUT="${HELM_TIMEOUT:-10m}"
BUILD_CONTEXT="${BUILD_CONTEXT:-.}"
DOCKERFILE="${DOCKERFILE:-Dockerfile}"
VALUES_FILE="${VALUES_FILE:-deploy/local-k8s/values-local.yaml}"
CHART_PATH="${CHART_PATH:-deploy/substrate/charts/tellus-tenant}"
LOCAL_K8S_DIR="${LOCAL_K8S_DIR:-deploy/local-k8s}"
SKIP_COMPOSE_WARN="${SKIP_COMPOSE_WARN:-0}"
REPLICAS="${REPLICAS:-}"

DO_BUILD=1
DO_RECREATE=0
SKIP_DEPS=0
WAIT=1
ENABLE_HPA=0
FOLLOW_LOGS=0

# --- pretty logging ----------------------------------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RST=$'\033[0m'; C_INF=$'\033[36m'; C_OK=$'\033[32m'; C_WRN=$'\033[33m'; C_ERR=$'\033[31m'
else
  C_RST=""; C_INF=""; C_OK=""; C_WRN=""; C_ERR=""
fi
as_line() { local IFS=' '; echo "$*"; }
ts()   { date +'%H:%M:%S'; }
log()  { printf '%s %s[k8s]%s %s\n'  "$(ts)" "$C_INF" "$C_RST" "$*"; }
ok()   { printf '%s %s[ ok]%s %s\n'  "$(ts)" "$C_OK"  "$C_RST" "$*"; }
warn() { printf '%s %s[warn]%s %s\n' "$(ts)" "$C_WRN" "$C_RST" "$*" >&2; }
die()  { printf '%s %s[err]%s %s\n'  "$(ts)" "$C_ERR" "$C_RST" "$*" >&2; exit 1; }

trap 'die "failed at line $LINENO (exit $?). Inspect: kubectl -n '"$NAMESPACE"' get pods,svc,deploy,sts"' ERR

usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

# --- args --------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)       PROVIDER="${2:-}"; shift ;;
    --provider=*)     PROVIDER="${1#*=}" ;;
    --cluster)        CLUSTER_NAME="${2:-}"; shift ;;
    --cluster=*)      CLUSTER_NAME="${1#*=}" ;;
    --no-build)       DO_BUILD=0 ;;
    --recreate)       DO_RECREATE=1 ;;
    --skip-deps)      SKIP_DEPS=1 ;;
    --no-wait)        WAIT=0 ;;
    --hpa)            ENABLE_HPA=1 ;;
    --logs)           FOLLOW_LOGS=1 ;;
    --replicas)       REPLICAS="${2:-}"; shift ;;
    --replicas=*)     REPLICAS="${1#*=}" ;;
    --image-tag)      IMAGE_TAG="${2:-}"; shift ;;
    --image-tag=*)    IMAGE_TAG="${1#*=}" ;;
    -h|--help)        usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

case "$PROVIDER" in
  kind|k3d) ;;
  *) die "PROVIDER must be kind or k3d (got: $PROVIDER)" ;;
esac

IMAGE_REF="${IMAGE_REPO}:${IMAGE_TAG}"
FULL_IMAGE_REF="${IMAGE_REF}"

# --- helpers -----------------------------------------------------------------
need_cmd() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not on PATH"; }

cluster_exists() {
  case "$PROVIDER" in
    kind) kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME" ;;
    k3d)  k3d cluster list -o json 2>/dev/null | grep -q "\"name\":\"${CLUSTER_NAME}\"" \
            || k3d cluster list 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$CLUSTER_NAME" ;;
  esac
}

use_context() {
  case "$PROVIDER" in
    kind) kubectl config use-context "kind-${CLUSTER_NAME}" >/dev/null ;;
    k3d)  kubectl config use-context "k3d-${CLUSTER_NAME}" >/dev/null ;;
  esac
}

delete_cluster() {
  log "deleting existing ${PROVIDER} cluster '${CLUSTER_NAME}'…"
  case "$PROVIDER" in
    kind) kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1 || true ;;
    k3d)  k3d cluster delete "$CLUSTER_NAME" >/dev/null 2>&1 || true ;;
  esac
}

create_cluster() {
  log "creating ${PROVIDER} cluster '${CLUSTER_NAME}'…"
  case "$PROVIDER" in
    kind)
      kind create cluster \
        --name "$CLUSTER_NAME" \
        --config "${LOCAL_K8S_DIR}/kind.yaml" \
        --wait 120s
      ;;
    k3d)
      # k3d accepts a config file; fall back to equivalent flags if needed.
      if k3d cluster create --config "${LOCAL_K8S_DIR}/k3d.yaml" --wait 2>/dev/null; then
        :
      else
        k3d cluster create "$CLUSTER_NAME" \
          --servers 1 --agents 0 \
          --port "3000:30000@server:0" \
          --port "5433:30001@server:0" \
          --k3s-arg "--disable=traefik@server:*" \
          --wait
      fi
      ;;
  esac
  use_context
  kubectl wait --for=condition=Ready nodes --all --timeout=180s >/dev/null
  ok "cluster ready"
}

load_image() {
  log "loading image ${FULL_IMAGE_REF} into ${PROVIDER} cluster…"
  case "$PROVIDER" in
    kind)
      kind load docker-image "$FULL_IMAGE_REF" --name "$CLUSTER_NAME"
      ;;
    k3d)
      k3d image import "$FULL_IMAGE_REF" -c "$CLUSTER_NAME"
      ;;
  esac
  ok "image loaded"
}

install_metrics_server() {
  # kind/k3d often lack metrics-server; required for HPA.
  if kubectl -n kube-system get deploy metrics-server >/dev/null 2>&1; then
    ok "metrics-server already present"
    return 0
  fi
  log "installing metrics-server (HPA prerequisite)…"
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml >/dev/null
  # kind needs insecure TLS to kubelet.
  kubectl -n kube-system patch deploy metrics-server --type='json' -p='[
    {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"},
    {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname"}
  ]' >/dev/null 2>&1 || true
  kubectl -n kube-system rollout status deploy/metrics-server --timeout=180s >/dev/null || \
    warn "metrics-server not ready yet — HPA may lag"
  ok "metrics-server installed"
}

wait_rollout() {
  local kind="$1" name="$2" timeout="${3:-300s}"
  log "waiting for ${kind}/${name}…"
  kubectl -n "$NAMESPACE" rollout status "${kind}/${name}" --timeout="$timeout"
}

wait_http_ready() {
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  local url="http://127.0.0.1:3000/api/v1/system/readiness"
  local health="http://127.0.0.1:3000/api/v1/health"
  log "waiting up to ${HEALTH_TIMEOUT}s for ${url}…"
  while :; do
    if curl -sf --max-time 3 "$url" >/dev/null 2>&1; then
      ok "readiness endpoint is green"
      if curl -sf --max-time 3 "$health" >/dev/null 2>&1; then
        ok "canonical /api/v1/health is green"
      else
        warn "/api/v1/health not fully healthy yet (may be degraded on soft deps)"
      fi
      return 0
    fi
    if [[ $(date +%s) -ge $deadline ]]; then
      warn "last pod status:"
      kubectl -n "$NAMESPACE" get pods -o wide || true
      warn "app logs (tail):"
      kubectl -n "$NAMESPACE" logs -l app.kubernetes.io/name=tellus --tail=80 || true
      die "app did not become ready within ${HEALTH_TIMEOUT}s"
    fi
    printf '%s %s[..]%s waiting for readiness…\n' "$(ts)" "$C_INF" "$C_RST"
    sleep 5
  done
}

summary() {
  echo
  ok "Tellus local Kubernetes stack is up."
  cat <<EOF

  Cluster     : ${PROVIDER}/${CLUSTER_NAME}
  Namespace   : ${NAMESPACE}
  Release     : ${RELEASE_NAME}
  Image       : ${FULL_IMAGE_REF}

  Endpoints (host):
    • App / API          http://127.0.0.1:3000
    • Health (live)      http://127.0.0.1:3000/api/v1/system/liveness
    • Health (ready)     http://127.0.0.1:3000/api/v1/system/readiness
    • Health (canonical) http://127.0.0.1:3000/api/v1/health
    • Postgres (debug)   127.0.0.1:5433  (user=tellus db=tellus_db)

  In-cluster DNS:
    • postgres.tenant-local.svc.cluster.local:5432
    • minio.tenant-local.svc.cluster.local:9000
    • opensearch.tenant-local.svc.cluster.local:9200
    • redis.tenant-local.svc.cluster.local:6379
    • tellus.tenant-local.svc.cluster.local:80

  Useful commands:
    kubectl -n ${NAMESPACE} get pods,svc,deploy,sts
    kubectl -n ${NAMESPACE} logs -f deploy/tellus
    kubectl -n ${NAMESPACE} describe deploy/tellus
    helm status ${RELEASE_NAME} -n ${NAMESPACE}
    ./scripts/k8s-local-down.sh

EOF
  log "resources:"
  kubectl -n "$NAMESPACE" get pods,svc,deploy,sts,job 2>/dev/null || true
}

warn_if_compose_running() {
  [[ "$SKIP_COMPOSE_WARN" == "1" ]] && return 0
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qE '^tellus-'; then
    warn "Docker Compose Tellus containers are running (./run.sh stack)."
    warn "On 16 GiB machines this often OOMs the Kubernetes node."
    warn "Recommended: ./stop.sh   then re-run this script."
    warn "Continue anyway in 8s (Ctrl-C to abort)…"
    sleep 8
  fi
}

# --- preflight ---------------------------------------------------------------
preflight() {
  need_cmd docker
  need_cmd kubectl
  need_cmd helm
  need_cmd curl
  case "$PROVIDER" in
    kind) need_cmd kind ;;
    k3d)  need_cmd k3d ;;
  esac
  docker info >/dev/null 2>&1 || die "Docker daemon is not reachable"
  [[ -f "$DOCKERFILE" ]] || die "Dockerfile not found: $DOCKERFILE"
  [[ -f "$VALUES_FILE" ]] || die "values file not found: $VALUES_FILE"
  [[ -d "$CHART_PATH" ]] || die "chart not found: $CHART_PATH"
  [[ -d "${LOCAL_K8S_DIR}/deps" ]] || die "deps dir not found: ${LOCAL_K8S_DIR}/deps"
  helm lint "$CHART_PATH" -f "$VALUES_FILE" >/dev/null \
    || die "helm lint failed for $CHART_PATH with $VALUES_FILE"
  ok "preflight passed (provider=$PROVIDER cluster=$CLUSTER_NAME image=$FULL_IMAGE_REF)"
}

# --- main --------------------------------------------------------------------
main() {
  preflight
  warn_if_compose_running

  if [[ "$DO_RECREATE" -eq 1 ]]; then
    delete_cluster
  fi

  if cluster_exists; then
    ok "reusing existing cluster '${CLUSTER_NAME}'"
    use_context
  else
    create_cluster
  fi

  # Ensure the default StorageClass works for StatefulSet PVCs (kind ships one).
  if ! kubectl get storageclass >/dev/null 2>&1 || [[ -z "$(kubectl get storageclass -o name 2>/dev/null)" ]]; then
    warn "no StorageClass found — StatefulSet PVCs may Pending"
  fi

  # Best-effort node sysctl for OpenSearch (not required when node.store.allow_mmap=false,
  # but improves production-likeness when the node allows it).
  if [[ "$PROVIDER" == "kind" ]]; then
    docker exec "${CLUSTER_NAME}-control-plane" sysctl -w vm.max_map_count=262144 >/dev/null 2>&1 \
      && ok "vm.max_map_count=262144 on kind node" \
      || warn "could not set vm.max_map_count on kind node (mmap disabled in OS manifest)"
  fi

  if [[ "$DO_BUILD" -eq 1 ]]; then
    log "building image ${FULL_IMAGE_REF} from ${DOCKERFILE}…"
    docker build -t "$FULL_IMAGE_REF" -f "$DOCKERFILE" "$BUILD_CONTEXT"
    ok "image built"
  else
    if ! docker image inspect "$FULL_IMAGE_REF" >/dev/null 2>&1; then
      die "image $FULL_IMAGE_REF not present locally (drop --no-build or build first)"
    fi
    ok "reusing local image $FULL_IMAGE_REF"
  fi

  load_image

  if [[ "$ENABLE_HPA" -eq 1 ]]; then
    install_metrics_server
  fi

  if [[ "$SKIP_DEPS" -eq 0 ]]; then
    log "applying namespace + dependency manifests…"
    kubectl apply -f "${LOCAL_K8S_DIR}/namespace.yaml"
    # Apply in sorted order: secrets → postgres → minio → opensearch → redis
    local f
    for f in "${LOCAL_K8S_DIR}/deps/"*.yaml; do
      log "  apply $(basename "$f")"
      kubectl apply -f "$f"
    done
    ok "dependency manifests applied"

    if [[ "$WAIT" -eq 1 ]]; then
      wait_rollout sts postgres 300s
      wait_rollout deploy minio 180s
      wait_rollout deploy redis 120s
      wait_rollout sts opensearch 360s || warn "opensearch rollout slow — continuing (startupProbe will wait)"
      # Bootstrap job is best-effort if already completed from prior run.
      if kubectl -n "$NAMESPACE" get job minio-bootstrap >/dev/null 2>&1; then
        if ! kubectl -n "$NAMESPACE" wait --for=condition=complete job/minio-bootstrap --timeout=180s 2>/dev/null; then
          warn "minio-bootstrap not complete — check: kubectl -n $NAMESPACE logs job/minio-bootstrap"
        else
          ok "minio bucket bootstrap complete"
        fi
      fi
    fi
  else
    warn "--skip-deps: not re-applying dependency manifests"
  fi

  local helm_sets=(
    --set "image.repository=${IMAGE_REPO}"
    --set "image.tag=${IMAGE_TAG}"
    --set "image.pullPolicy=IfNotPresent"
  )
  if [[ -n "$REPLICAS" ]]; then
    helm_sets+=(--set "replicaCount=${REPLICAS}" --set "autoscaling.enabled=false")
  fi
  if [[ "$ENABLE_HPA" -eq 1 ]]; then
    helm_sets+=(--set "autoscaling.enabled=true" --set "autoscaling.minReplicas=1" --set "autoscaling.maxReplicas=3")
  fi

  log "helm upgrade --install ${RELEASE_NAME}…"
  local helm_cmd=(
    helm upgrade --install "$RELEASE_NAME" "$CHART_PATH"
    --namespace "$NAMESPACE"
    --create-namespace
    -f "$VALUES_FILE"
    "${helm_sets[@]}"
    --timeout "$HELM_TIMEOUT"
  )
  if [[ "$WAIT" -eq 1 ]]; then
    # --wait gates on readiness; avoid --atomic so a slow first migrate does
    # not wipe the release on progress-deadline flake (deadline is 900s).
    helm_cmd+=(--wait)
  fi
  "${helm_cmd[@]}"

  ok "helm release ${RELEASE_NAME} applied"

  if [[ "$WAIT" -eq 1 ]]; then
    wait_rollout deploy tellus "${HELM_TIMEOUT}"
    wait_http_ready
  else
    warn "--no-wait: not gating on health"
  fi

  summary

  if [[ "$FOLLOW_LOGS" -eq 1 ]]; then
    log "tailing app logs (Ctrl-C to detach; stack keeps running)…"
    exec kubectl -n "$NAMESPACE" logs -f deploy/tellus
  fi
}

main "$@"
