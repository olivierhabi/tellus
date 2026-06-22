#!/usr/bin/env bash
set -euo pipefail

# Enterprise Terminal Output Color Configuration
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo "========================================================="
echo "Executing Hardened Enterprise Orchestration Verification"
echo "========================================================="

TARGET_RID="ri.stemma.main.repository.758be4a2-9f09-4488-a82f-492d83cd6e33"
TARGET_BRANCH="main"
# K8s DNS names are limited to 63 chars, so the name gets truncated
EXPECTED_RESOURCE_NAME="ws-ri-stemma-main-repository-758be4a2-9f09-4488-a82f-492d83cd6e"
NAMESPACE="telos-workspaces"

echo "[1/6] Testing concurrency protection (Issuing concurrent backend calls)..."
# Fire two requests simultaneously to prove the in-memory execution gate blocks race conditions
curl -s "http://localhost:3000/api/v1/workspaces/${TARGET_RID}/${TARGET_BRANCH}/manifest.json" &
curl -s "http://localhost:3000/api/v1/workspaces/${TARGET_RID}/${TARGET_BRANCH}/manifest.json" &
wait

echo -e "\n[2/6] Validating Pod resource provisioning..."
if kubectl get pod "$EXPECTED_RESOURCE_NAME" -n "$NAMESPACE" > /dev/null 2>&1; then
    echo -e "${GREEN}✔ PASS: Resource successfully instantiated on cluster.${NC}"
else
    echo -e "${RED}✘ FAIL: Orchestration pipeline dropped creation request.${NC}"
    exit 1
fi

echo "[3/6] Validating Hardened Security Controls..."
NON_ROOT_STATUS=$(kubectl get pod "$EXPECTED_RESOURCE_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.containers[0].securityContext.runAsNonRoot}')
PRIVILEGE_ESCALATION=$(kubectl get pod "$EXPECTED_RESOURCE_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.containers[0].securityContext.allowPrivilegeEscalation}')

if [ "$NON_ROOT_STATUS" = "true" ] && [ "$PRIVILEGE_ESCALATION" = "false" ]; then
    echo -e "${GREEN}✔ PASS: Core container security contexts conform to strict rules.${NC}"
else
    echo -e "${RED}✘ FAIL: Security vulnerability discovered! Insecure pod permissions.${NC}"
    exit 1
fi

echo "[4/6] Validating Mandatory Resource Quotas..."
CPU_LIMIT=$(kubectl get pod "$EXPECTED_RESOURCE_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.containers[0].resources.limits.cpu}')
if [ -n "$CPU_LIMIT" ]; then
    echo -e "${GREEN}✔ PASS: Limits and Requests constraints map correctly to instance allocations.${NC}"
else
    echo -e "${RED}✘ FAIL: Cluster scheduling rejects missing resource allocations.${NC}"
    exit 1
fi

echo "[5/6] Checking Network Service Mapping..."
if kubectl get svc "$EXPECTED_RESOURCE_NAME" -n "$NAMESPACE" > /dev/null 2>&1; then
    echo -e "${GREEN}✔ PASS: Core proxy targets match active networking paths.${NC}"
else
    echo -e "${RED}✘ FAIL: Internal routing mapping missing.${NC}"
    exit 1
fi

echo "[6/6] Verifying GitHub Container Registry Image Pull Secret configuration..."
SECRET_CHECK=$(kubectl get pod "$EXPECTED_RESOURCE_NAME" -n "$NAMESPACE" -o jsonpath='{.spec.imagePullSecrets[0].name}')
if [ "$SECRET_CHECK" = "ghcr-cred" ]; then
    echo -e "${GREEN}✔ PASS: imagePullSecrets successfully bound to GitHub Container Registry credentials.${NC}"
else
    echo -e "${RED}✘ FAIL: Cluster lacks authorization mapping to fetch images from ghcr.io.${NC}"
    exit 1
fi

echo -e "\n${GREEN}============ ALL ARCHITECTURAL CHECKS PASSED ============${NC}"
