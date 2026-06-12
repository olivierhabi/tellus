#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FOUNDRY-GAPS §3 — LIVE proof: NODE-LEVEL autoscaling with the REAL Karpenter
# controller (kubernetes-sigs/karpenter) running the **kwok** infrastructure
# provider on a local kind cluster.
#
# This is the genuinely-local way to exercise Karpenter end-to-end: the kwok
# provider is the upstream project's own CI/dev provider — it runs the REAL
# Karpenter control loop (provisioner, disruption/consolidation, nodeclaim
# lifecycle) and only swaps the cloud machine API (EC2/ASG) for kwok's fake
# nodes. So everything Karpenter *decides* is real; only the VM that backs a
# NodeClaim is simulated. The cloud binding (AWS EC2 NodeClass + IAM) is the
# one honest residual that needs a real cloud compute plane — see FOUNDRY-GAPS §3.
#
# Proves the full node-autoscaling contract:
#   • SCALE-UP: unschedulable Pods -> Karpenter computes NodeClaim(s) ->
#     provider launches node(s) -> Pods schedule. Both right-sizing (one
#     correctly-sized large node) and fan-out (many capped-size nodes) shown.
#   • SCALE-DOWN: workload removed -> Karpenter consolidation drains and
#     deletes the now-empty nodes back to baseline (disruption-budget paced).
#
#   bash deploy/substrate/verify-karpenter-kwok.sh [--keep]
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"

CLUSTER="${KARP_CLUSTER:-karpenter-kwok}"
NS="kube-system"
KIND_NODE_IMAGE="${KIND_NODE_IMAGE:-kindest/node:v1.34.0}"
KARPENTER_REF="${KARPENTER_REF:-main}"
SRC_DIR="${KARPENTER_SRC:-/tmp/karpenter-src}"
ARCH="$(go env GOARCH 2>/dev/null || uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
KEEP="${1:-}"
export PATH="$PATH:$(go env GOPATH 2>/dev/null)/bin"

pass(){ printf '\033[32m✔ %s\033[0m\n' "$1"; }
fail(){ printf '\033[31m✘ %s\033[0m\n' "$1"; exit 1; }
step(){ printf '\n\033[1;36m── %s ──\033[0m\n' "$1"; }
kc(){ kubectl --context "kind-$CLUSTER" "$@"; }

cleanup(){ [ "$KEEP" = "--keep" ] || kind delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

for bin in kind kubectl helm ko go; do command -v "$bin" >/dev/null || fail "missing required tool: $bin"; done

step "1. kind cluster '$CLUSTER' ($KIND_NODE_IMAGE, arch=$ARCH)"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --image "$KIND_NODE_IMAGE" >/dev/null
fi
kc wait --for=condition=Ready node --all --timeout=120s >/dev/null
pass "kind cluster up ($(kc get nodes --no-headers | wc -l | tr -d ' ') real node)"

step "2. fetch Karpenter source ($KARPENTER_REF) for the kwok provider"
if [ ! -d "$SRC_DIR/.git" ]; then
  git clone --depth 1 --branch "$KARPENTER_REF" https://github.com/kubernetes-sigs/karpenter.git "$SRC_DIR" >/dev/null 2>&1 \
    || git clone --depth 1 https://github.com/kubernetes-sigs/karpenter.git "$SRC_DIR" >/dev/null 2>&1
fi
pass "karpenter source at $SRC_DIR ($(git -C "$SRC_DIR" rev-parse --short HEAD))"

step "3. install the kwok provider (fake-node machine API) into the cluster"
KUBECONFIG_CTX="kind-$CLUSTER"
kubectl config use-context "$KUBECONFIG_CTX" >/dev/null
( cd "$SRC_DIR" && KARPENTER_NAMESPACE="$NS" ./hack/install-kwok.sh ) >/dev/null 2>&1
kc -n "$NS" rollout status deploy -l app=kwok-controller --timeout=120s >/dev/null 2>&1 || true
kc -n "$NS" get deploy -l app=kwok-controller >/dev/null 2>&1 && pass "kwok controller installed" || fail "kwok install failed"

step "4. build the REAL Karpenter (kwok) controller image into kind (arch=$ARCH)"
IMG="$( cd "$SRC_DIR" && KIND_CLUSTER_NAME="$CLUSTER" KO_DOCKER_REPO=kind.local \
        ko build --local=false --platform="linux/$ARCH" -B sigs.k8s.io/karpenter/kwok 2>/dev/null | tail -1 )"
[ -n "$IMG" ] || fail "ko build produced no image"
REPO="${IMG%%:*}"; TAG="${IMG##*:}"
pass "built + loaded $IMG"

step "5. deploy Karpenter (CRDs + helm chart) pointed at the built image"
kc apply -f "$SRC_DIR/kwok/charts/crds" >/dev/null
helm --kube-context "$KUBECONFIG_CTX" upgrade --install karpenter "$SRC_DIR/kwok/charts" \
  --namespace "$NS" --skip-crds \
  --set controller.image.repository="$REPO" \
  --set controller.image.tag="$TAG" \
  --set settings.preferencePolicy=Ignore \
  --set settings.featureGates.staticCapacity=false >/dev/null
kc -n "$NS" rollout status deploy/karpenter --timeout=150s >/dev/null
pass "Karpenter controller Running ($(kc -n "$NS" get deploy karpenter -o jsonpath='{.status.readyReplicas}')/1)"

step "6. register a NodePool + KWOKNodeClass (the autoscaling policy)"
cat <<'EOF' | kc apply -f - >/dev/null
apiVersion: karpenter.kwok.sh/v1alpha1
kind: KWOKNodeClass
metadata: {name: default}
---
apiVersion: karpenter.sh/v1
kind: NodePool
metadata: {name: default}
spec:
  disruption:
    consolidationPolicy: WhenEmptyOrUnderutilized
    consolidateAfter: 30s
  limits: {cpu: "1000", memory: 1000Gi}
  template:
    spec:
      expireAfter: Never
      requirements:
        - {key: kubernetes.io/os, operator: In, values: ["linux"]}
        - {key: karpenter.sh/capacity-type, operator: In, values: ["on-demand","spot"]}
      nodeClassRef: {group: karpenter.kwok.sh, kind: KWOKNodeClass, name: default}
EOF
BASE_KNODES=$(kc get nodes -l kwok.x-k8s.io/node=fake --no-headers 2>/dev/null | grep -c Ready || true)
[ "$BASE_KNODES" = "0" ] && pass "baseline: 0 Karpenter-managed nodes, NodePool ready" || fail "expected 0 karpenter nodes at baseline"

deploy_inflate(){ # $1=replicas
  cat <<EOF | kc apply -f - >/dev/null
apiVersion: apps/v1
kind: Deployment
metadata: {name: inflate}
spec:
  replicas: $1
  selector: {matchLabels: {app: inflate}}
  template:
    metadata: {labels: {app: inflate}}
    spec:
      terminationGracePeriodSeconds: 0
      nodeSelector: {karpenter.sh/nodepool: default}
      containers:
        - name: inflate
          image: public.ecr.aws/eks-distro/kubernetes/pause:3.7
          resources: {requests: {cpu: "1", memory: 128Mi}}
EOF
}
knodes(){ kc get nodes -l kwok.x-k8s.io/node=fake --no-headers 2>/dev/null | grep -c Ready || true; }
running(){ kc get pods -l app=inflate --no-headers 2>/dev/null | grep -c Running || true; }

step "7. SCALE-UP (right-size): 12 unschedulable Pods -> Karpenter provisions"
deploy_inflate 12
t0=$SECONDS; ok=0
for _ in $(seq 1 36); do
  r=$(running); n=$(knodes)
  printf '   t+%-3ss  karpenter-nodes=%s  pods-running=%s/12\n' "$((SECONDS-t0))" "$n" "$r"
  [ "$r" = "12" ] && { ok=1; break; }; sleep 5
done
[ "$ok" = "1" ] || fail "Karpenter did not schedule all 12 pods"
ITYPE=$(kc get nodeclaims -o jsonpath='{.items[0].metadata.labels.node\.kubernetes\.io/instance-type}' 2>/dev/null)
pass "Karpenter right-sized $(knodes) node(s) (chose $ITYPE) — all 12 Pods Running"

step "8. SCALE-DOWN: remove workload -> consolidation drains nodes to baseline"
kc delete deploy/inflate --wait=true >/dev/null 2>&1 || true
t0=$SECONDS; ok=0
for _ in $(seq 1 60); do
  n=$(knodes); nc=$(kc get nodeclaims --no-headers 2>/dev/null | wc -l | tr -d ' ')
  printf '   t+%-3ss  karpenter-nodes=%s  nodeclaims=%s\n' "$((SECONDS-t0))" "$n" "$nc"
  [ "$n" = "0" ] && { ok=1; break; }; sleep 5
done
[ "$ok" = "1" ] || fail "Karpenter did not consolidate nodes back to baseline"
pass "consolidation removed all Karpenter nodes — back to baseline (0)"

step "9. SCALE-UP (fan-out): cap NodePool to small instances -> many nodes"
kc patch nodepool default --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/requirements/-","value":{"key":"node.kubernetes.io/instance-type","operator":"In","values":["c-2x-amd64-linux"]}}]' >/dev/null
deploy_inflate 10
t0=$SECONDS; ok=0; MAX=0
for _ in $(seq 1 36); do
  r=$(running); n=$(knodes); [ "$n" -gt "$MAX" ] && MAX=$n
  printf '   t+%-3ss  karpenter-nodes=%s  pods-running=%s/10\n' "$((SECONDS-t0))" "$n" "$r"
  [ "$r" = "10" ] && { ok=1; break; }; sleep 5
done
[ "$ok" = "1" ] || fail "Karpenter did not fan out small nodes for the capped workload"
pass "Karpenter fanned out to $MAX capped (c-2x) nodes — all 10 Pods Running"

kc delete deploy/inflate --wait=false >/dev/null 2>&1 || true

printf '\n\033[1;32m✔ §3 NODE-LEVEL autoscaling verified on real Kubernetes (kind) with the REAL\n'
printf '  Karpenter controller (kwok provider): scale-up right-size + fan-out, and\n'
printf '  consolidation scale-down all proven. Cloud residual: EC2 NodeClass binding.\033[0m\n'
[ "$KEEP" = "--keep" ] && echo "  (cluster kept: kind delete cluster --name $CLUSTER)" || echo "  (cluster torn down)"
