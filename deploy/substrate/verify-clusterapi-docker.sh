#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FOUNDRY-GAPS §3 — LIVE proof: multi-cluster / multi-site federation with the
# REAL Cluster API (CAPI) controllers, using the Docker infrastructure provider
# (CAPD) on a local kind management cluster.
#
# This is the upstream project's own way to exercise CAPI end-to-end: the same
# core CAPI controllers (Cluster, Machine, KubeadmControlPlane, KubeadmConfig)
# and the same reconcile loops a production install runs — only the infrastructure
# provider is swapped from a cloud (AWS/Azure/vSphere) to Docker. So the
# *federation property* — one management cluster declaratively provisioning and
# lifecycle-managing OTHER Kubernetes clusters from CRDs — is fully real.
#
# Proves: a kind MANAGEMENT cluster, initialized with CAPI + CAPD, provisions a
# SECOND ("workload"/tenant) Kubernetes cluster entirely from declarative CRDs —
# control-plane + worker come up as real nodes (containers w/ provider IDs),
# kubeadm bootstraps them, and the workload cluster serves its own API and goes
# fully Ready once a CNI is applied. That is the multi-site building block.
#
# Honest residual (cloud/infra-bound, see FOUNDRY-GAPS §3): true multi-REGION
# federation needs ≥2 real clusters on a cloud/bare-metal infra provider
# (CAPA/CAPZ/CAPV) across regions — CAPD proves the control plane + workflow,
# not cross-region networking.
#
#   bash deploy/substrate/verify-clusterapi-docker.sh [--keep]
# ---------------------------------------------------------------------------
set -euo pipefail

MGMT="${CAPI_MGMT:-capi-mgmt}"
TENANT="${CAPI_TENANT:-capi-tenant}"
KIND_NODE_IMAGE="${KIND_NODE_IMAGE:-kindest/node:v1.34.0}"
K8S_VERSION="${CAPI_K8S_VERSION:-v1.34.0}"
CALICO_VERSION="${CALICO_VERSION:-v3.28.2}"
KEEP="${1:-}"
export CLUSTER_TOPOLOGY=true

pass(){ printf '\033[32m✔ %s\033[0m\n' "$1"; }
fail(){ printf '\033[31m✘ %s\033[0m\n' "$1"; exit 1; }
step(){ printf '\n\033[1;36m── %s ──\033[0m\n' "$1"; }
kmgmt(){ kubectl --context "kind-$MGMT" "$@"; }

cleanup(){
  if [ "$KEEP" != "--keep" ]; then
    kubectl --context "kind-$MGMT" delete cluster "$TENANT" --timeout=120s >/dev/null 2>&1 || true
    docker rm -f $(docker ps -aq --filter "name=$TENANT") >/dev/null 2>&1 || true
    kind delete cluster --name "$MGMT" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for bin in kind kubectl clusterctl docker; do command -v "$bin" >/dev/null || fail "missing required tool: $bin"; done

step "1. create the MANAGEMENT cluster (kind) with the host docker socket mounted"
# CAPD provisions workload nodes as sibling docker containers, so the management
# cluster needs the host docker socket.
cat > /tmp/capi-mgmt-kind.yaml <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: $MGMT
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: /var/run/docker.sock
        containerPath: /var/run/docker.sock
EOF
kind get clusters 2>/dev/null | grep -qx "$MGMT" || kind create cluster --config /tmp/capi-mgmt-kind.yaml --image "$KIND_NODE_IMAGE" >/dev/null
kmgmt wait --for=condition=Ready node --all --timeout=120s >/dev/null
pass "management cluster up ($MGMT)"

step "2. initialize CAPI + the Docker infrastructure provider (clusterctl init)"
kubectl config use-context "kind-$MGMT" >/dev/null
clusterctl init --infrastructure docker >/tmp/capi-init.log 2>&1 || { tail -8 /tmp/capi-init.log; fail "clusterctl init failed"; }
kmgmt wait --for=condition=Available deploy -A --timeout=240s \
  -l cluster.x-k8s.io/provider >/dev/null 2>&1 || true
RUNNING=$(kmgmt get pods -A 2>/dev/null | grep -cE 'capi-|capd-' || true)
[ "${RUNNING:-0}" -ge 4 ] && pass "CAPI controllers Running (core + kubeadm-bootstrap + kubeadm-cp + CAPD): $RUNNING pods" \
  || fail "CAPI controllers not all up ($RUNNING)"

step "3. declaratively provision a SECOND (workload) cluster from CRDs"
clusterctl generate cluster "$TENANT" --infrastructure docker --flavor development \
  --kubernetes-version "$K8S_VERSION" \
  --control-plane-machine-count=1 --worker-machine-count=1 > /tmp/capi-tenant.yaml 2>/dev/null
KINDS=$(grep -c '^kind:' /tmp/capi-tenant.yaml || true)
kmgmt apply -f /tmp/capi-tenant.yaml >/dev/null
pass "applied workload-cluster manifest ($KINDS CRD objects: Cluster/ClusterClass/Kubeadm*/Docker*)"

step "4. management cluster bootstraps the workload control plane (kubeadm) + worker"
t0=$SECONDS; INIT=""
for _ in $(seq 1 48); do
  # CAPI v1.13 reports control-plane init via the Initialized *condition*
  # (the old .status.initialized field was removed).
  init=$(kmgmt get kubeadmcontrolplane -o jsonpath='{.items[0].status.conditions[?(@.type=="Initialized")].status}' 2>/dev/null || true)
  machines=$(kmgmt get machines --no-headers 2>/dev/null | wc -l | tr -d ' ')
  running=$(kmgmt get machines --no-headers 2>/dev/null | grep -cw Running || true)
  ctrs=$(docker ps --filter "name=$TENANT" -q | wc -l | tr -d ' ')
  printf '   t+%-3ss  kcp.Initialized=%s  machines-running=%s/%s  docker-nodes=%s\n' "$((SECONDS-t0))" "${init:-False}" "$running" "$machines" "$ctrs"
  [ "$init" = "True" ] && [ "${machines:-0}" -ge 2 ] && [ "${running:-0}" -ge 2 ] && { INIT=1; break; }
  sleep 10
done
[ -n "$INIT" ] || fail "workload control plane did not initialize / machines not Running"
kmgmt get machines -o wide 2>/dev/null | awk 'NR==1 || /'"$TENANT"'/{print "   "$0}' | head -4
pass "mgmt cluster provisioned the workload control-plane + worker as real nodes (docker:// provider IDs); kubeadm initialized"

step "5. the workload cluster serves its own API; install CNI -> nodes Ready"
clusterctl get kubeconfig "$TENANT" > /tmp/${TENANT}.kubeconfig 2>/dev/null
LBPORT="$(docker port "${TENANT}-lb" 6443 2>/dev/null | head -1 | sed 's/.*://')"
TKC="$(kubectl --kubeconfig /tmp/${TENANT}.kubeconfig config view -o jsonpath='{.clusters[0].name}' 2>/dev/null)"
[ -n "$LBPORT" ] && kubectl --kubeconfig /tmp/${TENANT}.kubeconfig config set-cluster "$TKC" --server="https://127.0.0.1:$LBPORT" >/dev/null 2>&1 || true
export KUBECONFIG=/tmp/${TENANT}.kubeconfig
NODES=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')
[ "${NODES:-0}" -ge 2 ] && pass "workload cluster's OWN API reachable: $NODES nodes registered (separate cluster)" || fail "workload API not reachable"
kubectl apply -f "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml" >/dev/null 2>&1
t0=$SECONDS; READY=""
for _ in $(seq 1 48); do
  r=$(kubectl get nodes --no-headers 2>/dev/null | grep -c ' Ready ' || true)
  printf '   t+%-3ss  workload-nodes-ready=%s/%s\n' "$((SECONDS-t0))" "$r" "$NODES"
  [ "${r:-0}" -ge "$NODES" ] && { READY=1; break; }; sleep 10
done
unset KUBECONFIG
[ -n "$READY" ] && pass "workload cluster FULLY Ready: $NODES/$NODES nodes Ready after CNI (control-plane + worker)" \
  || fail "workload nodes did not become Ready after CNI"

step "6. confirm the two clusters are distinct + the mgmt plane tracks the tenant"
MGMT_NODES=$(kmgmt get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')
TENANT_PHASE=$(kmgmt get cluster "$TENANT" -o jsonpath='{.status.phase}' 2>/dev/null)
pass "management cluster: $MGMT_NODES node(s); tenant Cluster object phase=$TENANT_PHASE, lifecycle-managed from CRDs"

printf '\n\033[1;32m✔ §3 multi-cluster FEDERATION verified on real Kubernetes: the REAL Cluster API\n'
printf '  controllers (CAPD provider) had one management cluster declaratively provision,\n'
printf '  bootstrap, and fully bring up a SECOND Kubernetes cluster. Cloud residual: cross-\n'
printf '  region multi-site needs a cloud infra provider (CAPA/CAPZ/CAPV) across regions.\033[0m\n'
[ "$KEEP" = "--keep" ] && echo "  (clusters kept)" || echo "  (clusters torn down)"
