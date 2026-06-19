#!/bin/bash
# =============================================================================
# Quick Full-Stack Verification Test
# =============================================================================

echo "=========================================="
echo "Full-Stack E2E Verification"
echo "=========================================="

# Test 1: Backend Health
echo ""
echo "1. Infrastructure Health"
echo "------------------------"
curl -s http://localhost:3000/api/v1/health | python3 -c "import sys, json; d=json.load(sys.stdin); print(f'Backend: {d[\"status\"]}'); print(f'PostgreSQL: {d[\"postgres\"]}')" 2>/dev/null || echo "Backend check failed"

# Test 2: Frontend
echo ""
echo "2. Frontend Status"
echo "------------------"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -L http://localhost:3001 2>/dev/null || echo "000")
echo "Frontend HTTP Status: $STATUS"

# Test 3: Unit Tests
echo ""
echo "3. Backend Unit Tests"
echo "--------------------"
cd /Users/olivierhabimana/Desktop/projects/tellus
npx vitest run --config vitest.unit.config.ts tests/connectivity/unit 2>&1 | tail -5

# Test 4: TypeScript Compilation
echo ""
echo "4. TypeScript Compilation"
echo "-------------------------"
ERRORS=$(npx tsc --noEmit --skipLibCheck 2>&1 | grep -c "error TS" || echo "0")
echo "TypeScript Errors: $ERRORS"

# Test 5: Database Tables
echo ""
echo "5. Database Schema"
echo "------------------"
docker exec tellus-postgres-1 psql -U tellus -d tellus_db -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_name LIKE 'connectivity%';" 2>/dev/null | tr -d ' ' || echo "DB check failed"

# Test 6: Migration Count
echo ""
echo "6. Migrations"
echo "-------------"
ls -1 src/migrations/07[4-9]*.sql src/migrations/08[0-3]*.sql 2>/dev/null | wc -l || echo "0"

# Test 7: Service Files
echo ""
echo "7. Service Implementation"
echo "------------------------"
find src/services/connectivity -name "*.ts" 2>/dev/null | wc -l || echo "0"

# Test 8: Frontend Components
echo ""
echo "8. Frontend Components"
echo "---------------------"
find /Users/olivierhabimana/Desktop/projects/tellus-fe/components/data-connection -name "*.tsx" 2>/dev/null | wc -l || echo "0"

# Test 9: Test Files
echo ""
echo "9. Test Coverage"
echo "----------------"
UNIT=$(find tests/connectivity/unit -name "*.test.ts" 2>/dev/null | wc -l || echo "0")
INTEGRATION=$(find tests/connectivity/integration -name "*.test.ts" 2>/dev/null | wc -l || echo "0")
CYPRESS=$(find /Users/olivierhabimana/Desktop/projects/tellus-fe/cypress/e2e -name "*data-connection*" 2>/dev/null | wc -l || echo "0")
echo "Unit Tests: $UNIT files"
echo "Integration Tests: $INTEGRATION files"
echo "Cypress E2E Tests: $CYPRESS files"

# Test 10: Documentation
echo ""
echo "10. Documentation"
echo "-----------------"
if [ -d "docs/user/data-connection" ]; then
    find docs/user/data-connection -name "*.md" 2>/dev/null | wc -l || echo "0"
else
    echo "0"
fi

echo ""
echo "=========================================="
echo "Verification Complete"
echo "=========================================="
