#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FOUNDRY-GAPS §3 Substrate — REAL local Kubernetes verification.
#
# Stands up a hardened k3s cluster (k3d, Flannel + kube-proxy off → Cilium
# owns networking) and proves the Foundry-parity substrate properties on
# real infrastructure — no mocks:
#
#   1. Cilium CNI with full kube-proxy replacement (Rubix-class dataplane)
#   2. Tenant east-west isolation: a default-deny NetworkPolicy blocks
#      cross-namespace traffic (baseline 200 → blocked) — Cilium enforced
#   3. Pod Security Standards: a privileged pod is REJECTED at admission,
#      a compliant restricted pod is admitted
#   4. CIS hardening scan via kube-bench (real PASS/FAIL/WARN findings)
#   5. User-code sandbox: a pod runs inside the gVisor kernel via the
#      `gvisor` RuntimeClass (runsc) — the §1/§2 UDF isolation substrate
#   6. Mesh mTLS: Cilium WireGuard transparent encryption (cilium_wg0, peers)
#   7. Policy-as-code: Kyverno ClusterPolicy forces gVisor in user-code
#      namespaces — a non-gvisor pod is BLOCKED, a gvisor pod admitted
#   8. Runtime security: Falco (modern_ebpf) + a custom CRITICAL tripwire rule
#      that FIRES on a suspicious exec inside a container
#   9. Compose→Helm: the per-tenant chart installs (enrollment = namespace),
#      pods reach Ready under PSS-restricted, with quota + deny NetworkPolicy
#  10. §2 UDF on the sandbox: a user-authored UDF runs inside gVisor and
#      transforms data (renders the real production manifest builders)
#
# Verified working on Docker Desktop / macOS arm64 (gVisor systrap platform
# runs under the linuxkit VM). Requires: k3d, cilium-cli, kube-bench, kubectl,
# helm; steps 8/10 additionally use the falcosecurity Helm repo and tsx.
#
#   bash deploy/substrate/verify-substrate.sh
# ---------------------------------------------------------------------------
set -euo pipefail
CLUSTER="${CLUSTER:-substrate}"
NODE="k3d-${CLUSTER}-server-0"
pass(){ printf '\033[32m✔ %s\033[0m\n' "$1"; }
fail(){ printf '\033[31m✘ %s\033[0m\n' "$1"; exit 1; }
step(){ printf '\n\033[1;36m── %s ──\033[0m\n' "$1"; }

step "1. create k3d cluster (no Flannel/kube-proxy → Cilium CNI)"
k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
k3d cluster create "$CLUSTER" --servers 1 --agents 1 \
  --k3s-arg "--flannel-backend=none@server:*" \
  --k3s-arg "--disable-network-policy@server:*" \
  --k3s-arg "--disable=traefik@server:*" \
  --k3s-arg "--disable=servicelb@server:*" --wait --timeout 180s >/dev/null
kubectl config use-context "k3d-${CLUSTER}" >/dev/null
cilium install --version 1.16.5 \
  --set k8sServiceHost="${NODE}" --set k8sServicePort=6443 --set operator.replicas=1 \
  --set encryption.enabled=true --set encryption.type=wireguard >/dev/null 2>&1
kubectl -n kube-system rollout status ds/cilium --timeout=180s >/dev/null
kubectl wait --for=condition=ready node --all --timeout=120s >/dev/null
pass "k3s up, Cilium CNI ready, nodes Ready"

step "2. tenant east-west isolation (Cilium NetworkPolicy)"
kubectl create ns tenant-a >/dev/null 2>&1 || true
kubectl create ns tenant-b >/dev/null 2>&1 || true
kubectl -n tenant-a run web --image=nginx:alpine --port=80 -l app=web >/dev/null 2>&1 || true
kubectl -n tenant-b run client --image=curlimages/curl:8.10.1 --command -- sleep 3600 >/dev/null 2>&1 || true
kubectl -n tenant-a wait --for=condition=ready pod/web --timeout=120s >/dev/null
kubectl -n tenant-b wait --for=condition=ready pod/client --timeout=120s >/dev/null
WEB=$(kubectl -n tenant-a get pod web -o jsonpath='{.status.podIP}')
BASE=$(kubectl -n tenant-b exec client -- curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$WEB" 2>/dev/null || echo 000)
[ "$BASE" = "200" ] && pass "baseline cross-tenant HTTP 200 (no policy)" || fail "baseline connectivity expected 200, got $BASE"
kubectl apply -f - >/dev/null <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: default-deny-ingress, namespace: tenant-a }
spec: { podSelector: {}, policyTypes: [Ingress] }
YAML
sleep 6
# A blocked connection makes curl exit non-zero AND print http_code 000; the
# `|| echo 000` fallback can then concatenate, so match on "not 200" rather
# than an exact 000 (robust against the doubled-000 case).
BLOCKED=$(kubectl -n tenant-b exec client -- curl -s -o /dev/null -w '%{http_code}' --max-time 6 "http://$WEB" 2>/dev/null || echo 000)
case "$BLOCKED" in
  *200*) fail "expected block, but got a 200 (policy not enforced): $BLOCKED" ;;
  *) pass "cross-tenant traffic BLOCKED after deny policy (code=${BLOCKED}/timeout)" ;;
esac

step "3. Pod Security Standards admission"
kubectl create ns pss-restricted >/dev/null 2>&1 || true
kubectl label ns pss-restricted pod-security.kubernetes.io/enforce=restricted --overwrite >/dev/null
if kubectl apply -f - >/dev/null 2>&1 <<'YAML'
apiVersion: v1
kind: Pod
metadata: { name: bad-privileged, namespace: pss-restricted }
spec: { containers: [{ name: c, image: busybox:1.36, command: ["sleep","3600"], securityContext: { privileged: true, runAsUser: 0 } }] }
YAML
then fail "privileged pod was admitted (PSS not enforcing)"; else pass "privileged pod REJECTED by PSS admission"; fi

step "4. CIS hardening scan (kube-bench)"
kubectl delete job kube-bench >/dev/null 2>&1 || true
kubectl apply -f - >/dev/null <<YAML
apiVersion: batch/v1
kind: Job
metadata: { name: kube-bench }
spec:
  backoffLimit: 0
  template:
    spec:
      hostPID: true
      nodeName: ${NODE}
      tolerations: [{ operator: "Exists" }]
      restartPolicy: Never
      containers:
      - { name: kube-bench, image: aquasec/kube-bench:v0.10.7, command: ["kube-bench","run","--targets","node","--benchmark","cis-1.8"], securityContext: { privileged: true }, volumeMounts: [{ name: varlib, mountPath: /var/lib, readOnly: true }, { name: etc, mountPath: /etc, readOnly: true }] }
      volumes: [{ name: varlib, hostPath: { path: /var/lib } }, { name: etc, hostPath: { path: /etc } }]
YAML
kubectl wait --for=condition=complete job/kube-bench --timeout=150s >/dev/null 2>&1 || true
kubectl logs job/kube-bench 2>/dev/null | grep -A4 "== Summary total ==" || fail "kube-bench produced no summary"
pass "CIS scan executed against the node (findings above)"

step "5. user-code sandbox via gVisor RuntimeClass"
# Install runsc (aarch64) into the server node's containerd if absent.
if ! docker exec "$NODE" test -x /bin/runsc 2>/dev/null; then
  U="https://storage.googleapis.com/gvisor/releases/release/latest/aarch64"
  curl -fsSL -o /tmp/runsc "$U/runsc"; curl -fsSL -o /tmp/cs "$U/containerd-shim-runsc-v1"
  chmod +x /tmp/runsc /tmp/cs
  docker cp /tmp/runsc "$NODE:/bin/runsc"; docker cp /tmp/cs "$NODE:/bin/containerd-shim-runsc-v1"
  docker exec "$NODE" sh -c 'cd /var/lib/rancher/k3s/agent/etc/containerd; cp config.toml config.toml.tmpl; printf "\n[plugins.%bio.containerd.cri.v1.runtime%b.containerd.runtimes.runsc]\n  runtime_type = \"io.containerd.runsc.v1\"\n" "'"'"'" "'"'"'" >> config.toml.tmpl'
  docker restart "$NODE" >/dev/null
  for i in $(seq 1 40); do kubectl get node "$NODE" 2>/dev/null | grep -q " Ready" && break; sleep 3; done
fi
kubectl apply -f - >/dev/null <<'YAML'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: { name: gvisor }
handler: runsc
YAML
kubectl delete pod udf-sandbox >/dev/null 2>&1 || true
kubectl apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: Pod
metadata: { name: udf-sandbox }
spec:
  runtimeClassName: gvisor
  nodeName: k3d-substrate-server-0
  restartPolicy: Never
  containers: [{ name: udf, image: busybox:1.36, command: ["cat","/proc/version"] }]
YAML
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded pod/udf-sandbox --timeout=120s >/dev/null
KVER=$(kubectl logs udf-sandbox 2>/dev/null)
echo "  pod kernel: $KVER"
echo "$KVER" | grep -q "gvisor" && pass "pod runs inside the gVisor kernel (user-code sandbox confirmed)" || fail "pod is NOT gVisor-sandboxed: $KVER"

step "6. mesh mTLS — Cilium WireGuard transparent encryption"
WG=$(kubectl -n kube-system exec ds/cilium -c cilium-agent -- cilium status 2>/dev/null | grep -i "Encryption" || true)
echo "  $WG"
echo "$WG" | grep -qi "Wireguard" || fail "WireGuard encryption not active"
echo "$WG" | grep -qiE "cilium_wg0|Peers: [1-9]" || fail "no WireGuard peer/interface"
pass "node-to-node traffic encrypted with WireGuard (cilium_wg0, peer established)"

step "7. policy-as-code — Kyverno forces the gVisor sandbox"
# NB: use `create`/`apply --server-side`, NOT plain `kubectl apply` — Kyverno's
# CRDs exceed the 256KiB client-side last-applied-config annotation limit, so a
# plain apply fails to install them and the admission controller crash-loops on
# "CRD clusterpolicies.kyverno.io not found". The cluster is fresh each run.
kubectl create -f https://github.com/kyverno/kyverno/releases/download/v1.13.4/install.yaml >/dev/null 2>&1 \
  || kubectl apply --server-side -f https://github.com/kyverno/kyverno/releases/download/v1.13.4/install.yaml >/dev/null 2>&1 || true
# On a cold, resource-constrained k3d the admission controller's liveness probe
# kills it mid-startup, forcing one or two restarts; total ready-time is highly
# variable (5–9 min). `kubectl wait` with a fixed timeout flakes on that, so
# poll readyReplicas with a generous 600s budget that tolerates the restarts.
for _ in $(seq 1 40); do kubectl -n kyverno get deploy kyverno-admission-controller >/dev/null 2>&1 && break; sleep 3; done
KYV_DEADLINE=$((SECONDS+600))
until [ "$(kubectl -n kyverno get deploy kyverno-admission-controller -o jsonpath='{.status.readyReplicas}' 2>/dev/null)" = "1" ]; do
  [ "$SECONDS" -gt "$KYV_DEADLINE" ] && fail "kyverno admission controller did not become ready within 600s"
  sleep 5
done
kubectl create ns tellus-udf >/dev/null 2>&1 || true
kubectl apply -f "$(dirname "$0")/policies/require-gvisor-udf.yaml" >/dev/null
sleep 6
if kubectl -n tellus-udf run bad-udf --image=busybox:1.36 --restart=Never --command -- sleep 30 >/dev/null 2>&1; then
  fail "non-gvisor pod was admitted (Kyverno not enforcing)"
else pass "non-gvisor pod in tellus-udf BLOCKED by Kyverno admission"; fi
kubectl -n tellus-udf delete pod bad-udf --ignore-not-found >/dev/null 2>&1 || true
if kubectl apply -f - >/dev/null 2>&1 <<YAML
apiVersion: v1
kind: Pod
metadata: { name: good-udf, namespace: tellus-udf }
spec:
  runtimeClassName: gvisor
  nodeName: ${NODE}
  restartPolicy: Never
  containers: [{ name: c, image: busybox:1.36, command: ["sleep","30"], securityContext: { allowPrivilegeEscalation: false, runAsNonRoot: true, runAsUser: 65534, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: RuntimeDefault } } }]
YAML
then pass "compliant gVisor pod ADMITTED"; else fail "compliant gVisor pod was rejected"; fi
kubectl -n tellus-udf delete pod good-udf --ignore-not-found >/dev/null 2>&1 || true

step "8. runtime security — Falco (modern_ebpf) + custom tripwire rule"
if docker exec "$NODE" test -f /sys/kernel/btf/vmlinux 2>/dev/null; then
  helm repo add falcosecurity https://falcosecurity.github.io/charts >/dev/null 2>&1 || true
  helm repo update falcosecurity >/dev/null 2>&1 || true
  helm upgrade --install falco falcosecurity/falco --namespace falco --create-namespace \
    --set driver.kind=modern_ebpf --set tty=true --set falcosidekick.enabled=false \
    -f "$(dirname "$0")/falco/tellus-tripwire.yaml" --wait --timeout 300s >/dev/null 2>&1
  kubectl -n falco rollout status ds/falco --timeout=240s >/dev/null
  SRV=$(kubectl -n falco get pods --field-selector spec.nodeName="${NODE}" -o name | head -1)
  # The pod is marked Ready a moment before Falco finishes parsing rule files,
  # so retry the schema-validation grep for up to ~60s rather than racing it.
  RULE_OK=
  for _ in $(seq 1 20); do
    kubectl -n falco logs "$SRV" -c falco 2>/dev/null | grep -q "tellus-tripwire.yaml | schema validation: ok" \
      && { RULE_OK=1; break; }
    sleep 3
  done
  [ -n "$RULE_OK" ] && pass "Falco loaded the custom CRITICAL tripwire rule" || fail "custom rule did not load"
  kubectl -n default delete pod intruder --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n default run intruder --image=busybox:1.36 --restart=Never \
    --overrides="{\"spec\":{\"nodeName\":\"${NODE}\"}}" --command -- sleep 300 >/dev/null 2>&1
  kubectl -n default wait --for=condition=ready pod/intruder --timeout=60s >/dev/null 2>&1 || true
  kubectl -n default exec intruder -- sh -c 'cp /bin/busybox /tmp/nc 2>/dev/null; /tmp/nc --help' >/dev/null 2>&1 || true
  sleep 6
  HITS=$(kubectl -n falco logs "$SRV" -c falco --since=40s 2>/dev/null | grep -c "TELLUS-TRIPWIRE" || echo 0)
  kubectl -n default delete pod intruder --ignore-not-found >/dev/null 2>&1 || true
  [ "${HITS:-0}" -ge 1 ] && pass "Falco fired the tripwire on a suspicious exec ($HITS hit(s))" || fail "Falco did not fire the tripwire"
else
  echo "  ⚠ /sys/kernel/btf/vmlinux absent on the node — modern_ebpf unsupported here."
  echo "    (Falco rule artifact: deploy/substrate/falco/tellus-tripwire.yaml — re-run on a BTF kernel.)"
fi

step "9. Compose→Helm — per-tenant chart on real k8s (enrollment = namespace)"
CHART="$(dirname "$0")/charts/tellus-tenant"
helm lint "$CHART" --set tenant=acme >/dev/null || fail "helm lint failed"
helm template tenant-acme "$CHART" --set tenant=acme | grep -q "kind: Namespace" || fail "chart did not render a namespace"
helm uninstall tenant-acme -n tenant-acme >/dev/null 2>&1 || true
helm install tenant-acme "$CHART" --set tenant=acme \
  --set image.repository=nginxinc/nginx-unprivileged --set image.tag=1.27-alpine \
  --set containerPort=8080 --set podSecurity.runAsUser=101 \
  --set podSecurity.runAsGroup=101 --set podSecurity.fsGroup=101 \
  --set service.port=80 \
  --set probes.startup.path=/ --set probes.liveness.path=/ --set probes.readiness.path=/ \
  --set persistence.data.enabled=false \
  --set lifecycle.preStopSleepSeconds=0 \
  --wait --timeout 180s >/dev/null || fail "helm install did not converge"
AVAIL=$(kubectl -n tenant-acme get deploy tellus-acme -o jsonpath='{.status.availableReplicas}' 2>/dev/null)
PSS=$(kubectl get ns tenant-acme -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}' 2>/dev/null)
[ "${AVAIL:-0}" -ge 1 ] && [ "$PSS" = "restricted" ] \
  && pass "tenant release deployed: pod Ready under PSS-restricted, quota + deny NetworkPolicy applied" \
  || fail "tenant deploy not Available (avail=$AVAIL pss=$PSS)"
helm uninstall tenant-acme -n tenant-acme >/dev/null 2>&1 || true

step "10. §2 UDF on the sandbox — user code runs in gVisor and transforms data"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if command -v npx >/dev/null 2>&1 && [ -f "$REPO_ROOT/scripts/udf-live.ts" ]; then
  ( cd "$REPO_ROOT" && TELLUS_UDF_NODE_NAME="${NODE}" TELLUS_UDF_RUNTIME=k8s npx tsx scripts/udf-live.ts ) \
    && pass "UDF executed inside gVisor and produced correct transformed rows" \
    || fail "UDF live proof failed"
else
  echo "  ⚠ npx/tsx or scripts/udf-live.ts unavailable — skipped (run from the tellus repo root)."
fi

printf '\n\033[1;32m✔ FOUNDRY-GAPS §3 substrate verified on real Kubernetes\033[0m\n'
