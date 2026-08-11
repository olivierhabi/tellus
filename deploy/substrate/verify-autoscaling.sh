#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FOUNDRY-GAPS §3 — LIVE proof: horizontal pod autoscaling on real Kubernetes.
#
# Proves the per-tenant chart's HorizontalPodAutoscaler (templates/hpa.yaml)
# actually scales a tenant Deployment UP under load on a local k3d cluster with
# metrics-server — the genuinely local-testable half of "autoscaling + ephemeral
# nodes". (Node-level autoscaling — Karpenter / Cluster API — needs a real cloud
# compute plane and is intentionally out of scope here; see FOUNDRY-GAPS §3.)
#
# Steps: k3d cluster → metrics-server Ready → helm install the tenant chart with
# autoscaling.enabled (nginx app, tiny CPU request, target 50%) → hammer it with
# in-cluster load → assert the HPA drives replicas above minReplicas.
#
#   bash deploy/substrate/verify-autoscaling.sh [--keep]
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")"
CLUSTER="${HPA_CLUSTER:-tellus-hpa}"
NS="tenant-hpa"
APP="tellus-hpa"   # chart fullname = tellus-<tenant>; release name is "hpa"
KEEP="${1:-}"
pass(){ printf '\033[32m✔ %s\033[0m\n' "$1"; }
fail(){ printf '\033[31m✘ %s\033[0m\n' "$1"; exit 1; }
step(){ printf '\n\033[1;36m── %s ──\033[0m\n' "$1"; }

cleanup(){
  if [ "$KEEP" != "--keep" ]; then
    k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

step "1. k3d cluster '$CLUSTER' (k3s bundles metrics-server)"
if ! k3d cluster list 2>/dev/null | grep -q "^$CLUSTER "; then
  k3d cluster create "$CLUSTER" --agents 1 --wait >/dev/null
fi
kubectl config use-context "k3d-$CLUSTER" >/dev/null
for _ in $(seq 1 30); do
  [ "$(kubectl get nodes --no-headers 2>/dev/null | grep -c ' Ready ')" -ge 2 ] && break; sleep 2
done
kubectl get nodes --no-headers | grep -q ' Ready ' && pass "cluster up ($(kubectl get nodes --no-headers | wc -l | tr -d ' ') nodes)" || fail "nodes not Ready"

step "2. metrics-server Ready (HPA metrics source)"
# k3s ships metrics-server in kube-system; install upstream if absent.
if ! kubectl -n kube-system get deploy metrics-server >/dev/null 2>&1; then
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml >/dev/null
  # k3d kubelet serving certs are self-signed → allow insecure TLS.
  kubectl -n kube-system patch deploy metrics-server --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null 2>&1 || true
fi
kubectl -n kube-system rollout status deploy/metrics-server --timeout=180s >/dev/null
# Wait until metrics actually flow (top can lag the rollout).
for _ in $(seq 1 30); do kubectl top nodes >/dev/null 2>&1 && break; sleep 4; done
kubectl top nodes >/dev/null 2>&1 && pass "metrics-server serving node/pod metrics" || fail "metrics-server not serving metrics"

step "3. helm install tenant chart with autoscaling enabled"
helm uninstall hpa >/dev/null 2>&1 || true  # clean any prior/failed release
# The chart owns the namespace, so uninstall terminates it — wait for it to
# fully drain before reinstalling (else server-side apply races termination).
kubectl wait --for=delete "namespace/${NS}" --timeout=90s >/dev/null 2>&1 || true
# nginx-unprivileged runs as a non-root uid on :8080, so it satisfies the
# chart's PSS-restricted namespace (the default-root nginx is correctly REJECTED
# by PodSecurity — proven separately in verify-substrate.sh §3). readOnlyRootFs
# stays on (the chart mounts /tmp, /var/cache/nginx, /var/run as emptyDir).
helm upgrade --install hpa ./charts/tellus-tenant \
  --set tenant=hpa \
  --set image.repository=nginxinc/nginx-unprivileged --set image.tag=stable-alpine --set image.pullPolicy=IfNotPresent \
  --set containerPort=8080 --set probePath=/ \
  --set resources.requests.cpu=5m --set resources.limits.cpu=500m \
  --set autoscaling.enabled=true --set autoscaling.minReplicas=1 --set autoscaling.maxReplicas=5 \
  --set autoscaling.targetCPUUtilizationPercentage=40 \
  --set autoscaling.scaleDownStabilizationSeconds=30 \
  --wait --timeout 180s >/dev/null
kubectl -n "$NS" get hpa "$APP" >/dev/null 2>&1 && pass "chart rendered + applied an HPA (min=1 max=5 cpu=40%)" || fail "HPA not created by the chart"
kubectl -n "$NS" rollout status deploy/"$APP" --timeout=120s >/dev/null
# With autoscaling on, the Deployment omits .spec.replicas (HPA owns it), so the
# baseline is minReplicas (1). We assert status.replicas climbs above it.
START_REPLICAS=1
pass "tenant Deployment running at minReplicas=${START_REPLICAS}"

step "4. wait for the HPA to read CPU metrics (not <unknown>)"
for _ in $(seq 1 40); do
  cur=$(kubectl -n "$NS" get hpa "$APP" -o jsonpath='{.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null || true)
  [ -n "$cur" ] && break; sleep 5
done
[ -n "${cur:-}" ] && pass "HPA reading live CPU utilisation (${cur}%)" || fail "HPA never got CPU metrics from metrics-server"

step "5. generate in-cluster load → CPU crosses the 40% target"
SVC="${APP}.${NS}.svc.cluster.local"
# Apache Bench (bundled in httpd:alpine) drives sustained high-concurrency load —
# far heavier than a busybox wget loop, so the tiny nginx pod's CPU reliably
# crosses the HPA target. Two generators × 120 concurrent for up to 10 min.
for i in 1 2; do
  kubectl -n "$NS" run "load-$i" --image=httpd:2.4-alpine --restart=Never --command -- \
    ab -t 600 -c 120 "http://${SVC}/" >/dev/null 2>&1 || true
done
pass "2 ApacheBench load generators (-c 120) hammering http://${SVC}/"

step "6. observe the HPA scale the Deployment UP (replicas > min)"
SCALED=0; MAXSEEN=$START_REPLICAS
for _ in $(seq 1 60); do  # up to ~5 min
  reps=$(kubectl -n "$NS" get deploy "$APP" -o jsonpath='{.status.replicas}' 2>/dev/null || echo 0)
  util=$(kubectl -n "$NS" get hpa "$APP" -o jsonpath='{.status.currentMetrics[0].resource.current.averageUtilization}' 2>/dev/null || echo "?")
  desired=$(kubectl -n "$NS" get hpa "$APP" -o jsonpath='{.status.desiredReplicas}' 2>/dev/null || echo "?")
  printf '   t+%-3ss  cpu=%s%%  desired=%s  replicas=%s\n' "$((SECONDS))" "$util" "$desired" "$reps"
  [ "${reps:-0}" -gt "$MAXSEEN" ] && MAXSEEN=$reps
  if [ "${reps:-0}" -gt "$START_REPLICAS" ]; then SCALED=1; break; fi
  sleep 5
done

# Cleanup load generators regardless of outcome.
for i in 1 2 3; do kubectl -n "$NS" delete pod "load-$i" --force --grace-period=0 >/dev/null 2>&1 || true; done

[ "$SCALED" -eq 1 ] && pass "HPA scaled the tenant Deployment ${START_REPLICAS} → ${MAXSEEN} replica(s) under load" \
  || fail "HPA did not scale up within the window (max replicas seen: ${MAXSEEN})"

printf '\n\033[1;32m✔ §3 horizontal autoscaling verified on real Kubernetes (k3d + metrics-server + chart HPA)\033[0m\n'
[ "$KEEP" = "--keep" ] && echo "  (cluster kept: k3d cluster delete $CLUSTER)" || echo "  (cluster torn down)"
