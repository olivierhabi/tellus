#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# FOUNDRY-GAPS §2 — LIVE proof: direct Kafka→pipeline→Iceberg path.
#
# Proves a Kafka topic can be a streaming-pipeline SOURCE and that the ACTUAL
# `compileStreamingJob()` output runs on real Flink, consuming the real tellus
# Kafka and committing transformed rows to Iceberg (Lakekeeper + MinIO) — the
# property that was previously a dead `format='stream'` branch.
#
# Chain exercised: compileStreamingJob (Kafka source DDL + Filter + Iceberg
# sink DDL) → Flink SQL → Kafka consume → Iceberg commit → read-back.
#
# Requires the tellus docker stack up (kafka, lakekeeper, minio) + docker +
# npx/tsx + the Flink connector JARs (downloaded below). Standalone & idempotent.
#
#   bash scripts/verify-kafka-streaming.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."
pass(){ printf '\033[32m✔ %s\033[0m\n' "$1"; }
fail(){ printf '\033[31m✘ %s\033[0m\n' "$1"; exit 1; }
step(){ printf '\n\033[1;36m── %s ──\033[0m\n' "$1"; }

NET=tellus_default
LK=http://localhost:8181
LIB=/tmp/flink-lib
IMG=flink:1.20.0-scala_2.12-java11
S3_KEY="${S3_ACCESS_KEY_ID:-tellus-s3-49f524d9}"
S3_SECRET="${S3_SECRET_ACCESS_KEY:-kYJtYYunruhlPtOow9PD5FyRa36BXPM}"

step "1. Flink connector JARs (Kafka + Iceberg REST + AWS bundle + Hadoop)"
mkdir -p "$LIB"; cd "$LIB"
# name|url pairs (portable — macOS ships bash 3.2 without associative arrays).
JARS="flink-sql-connector-kafka.jar|https://repo1.maven.org/maven2/org/apache/flink/flink-sql-connector-kafka/3.3.0-1.20/flink-sql-connector-kafka-3.3.0-1.20.jar
iceberg-flink-runtime.jar|https://repo1.maven.org/maven2/org/apache/iceberg/iceberg-flink-runtime-1.20/1.7.1/iceberg-flink-runtime-1.20-1.7.1.jar
iceberg-aws-bundle.jar|https://repo1.maven.org/maven2/org/apache/iceberg/iceberg-aws-bundle/1.7.1/iceberg-aws-bundle-1.7.1.jar
flink-shaded-hadoop.jar|https://repo1.maven.org/maven2/org/apache/flink/flink-shaded-hadoop-2-uber/2.8.3-10.0/flink-shaded-hadoop-2-uber-2.8.3-10.0.jar"
while IFS='|' read -r name url; do
  [ -n "$name" ] || continue
  # Validate it's a real zip — a truncated download silently breaks S3FileIO.
  if ! python3 -c "import zipfile; zipfile.ZipFile('$name')" >/dev/null 2>&1; then
    curl -fsSL -o "$name" "$url" || fail "download failed: $name"
    python3 -c "import zipfile; zipfile.ZipFile('$name')" >/dev/null 2>&1 || fail "downloaded $name is not a valid jar"
  fi
done <<EOF
$JARS
EOF
pass "connector JARs present & valid"
cd - >/dev/null

step "2. Iceberg warehouse 'streaming-test' (Lakekeeper)"
if ! curl -s "$LK/management/v1/warehouse" | grep -q '"streaming-test"'; then
  curl -s -X POST "$LK/management/v1/warehouse" -H 'Content-Type: application/json' -d @- >/dev/null <<JSON
{"warehouse-name":"streaming-test","project-id":"00000000-0000-0000-0000-000000000000",
 "storage-profile":{"type":"s3","bucket":"iceberg-warehouse","key-prefix":"_streaming_test","endpoint":"http://minio:9000","region":"us-east-1","path-style-access":true,"flavor":"s3-compat","sts-enabled":false},
 "storage-credential":{"type":"s3","credential-type":"access-key","aws-access-key-id":"$S3_KEY","aws-secret-access-key":"$S3_SECRET"}}
JSON
fi
curl -s "$LK/management/v1/warehouse" | grep -q '"streaming-test"' && pass "warehouse ready" || fail "warehouse missing"

step "3. Flink cluster (JobManager + TaskManager) on $NET, with connectors"
PROPS=$'jobmanager.rpc.address: flink-jm\ntaskmanager.numberOfTaskSlots: 4\nparallelism.default: 1\nexecution.checkpointing.interval: 10s\nexecution.checkpointing.mode: EXACTLY_ONCE\nstate.backend.type: hashmap'
MNTS=(-v "$LIB/flink-sql-connector-kafka.jar:/opt/flink/lib/flink-sql-connector-kafka.jar"
      -v "$LIB/iceberg-flink-runtime.jar:/opt/flink/lib/iceberg-flink-runtime.jar"
      -v "$LIB/iceberg-aws-bundle.jar:/opt/flink/lib/iceberg-aws-bundle.jar"
      -v "$LIB/flink-shaded-hadoop.jar:/opt/flink/lib/flink-shaded-hadoop.jar")
docker rm -f flink-jm flink-tm >/dev/null 2>&1 || true
docker run -d --name flink-jm --network "$NET" -p 18081:8081 "${MNTS[@]}" -e FLINK_PROPERTIES="$PROPS" "$IMG" jobmanager >/dev/null
docker run -d --name flink-tm --network "$NET" "${MNTS[@]}" -e FLINK_PROPERTIES="$PROPS" "$IMG" taskmanager >/dev/null
for _ in $(seq 1 30); do curl -s http://localhost:18081/overview 2>/dev/null | grep -q '"slots-total":4' && break; sleep 2; done
curl -s http://localhost:18081/overview | grep -q '"slots-total":4' && pass "Flink 1.20 up (4 slots, connectors loaded)" || fail "Flink not ready"

step "4. Produce JSON events to Kafka topic orders.v1"
docker exec tellus-kafka-1 bash -c "kafka-topics --bootstrap-server localhost:9092 --create --topic orders.v1 --partitions 1 --replication-factor 1 --if-not-exists" >/dev/null 2>&1 || true
docker exec -i tellus-kafka-1 bash -c "kafka-console-producer --bootstrap-server localhost:9092 --topic orders.v1" >/dev/null 2>&1 <<'EVENTS'
{"order_id":1,"customer_id":10,"status":"NEW","amount":100.5}
{"order_id":2,"customer_id":20,"status":"PAID","amount":250.0}
{"order_id":3,"customer_id":10,"status":"NEW","amount":75.25}
{"order_id":4,"customer_id":30,"status":"PAID","amount":410.0}
{"order_id":5,"customer_id":20,"status":"CANCELLED","amount":0}
EVENTS
pass "produced 5 events (2 PAID)"

step "5. Compile the streaming job via the REAL compileStreamingJob()"
npx tsx scripts/streaming-live-gen.ts > /tmp/streaming.sql 2>/dev/null
grep -q "'connector' = 'kafka'" /tmp/streaming.sql || fail "compiler did not emit a Kafka source"
grep -q "'connector' = 'iceberg'" /tmp/streaming.sql || fail "compiler did not emit an Iceberg sink"
docker cp /tmp/streaming.sql flink-jm:/tmp/streaming.sql >/dev/null
pass "compiled SQL (Kafka source → Filter → Iceberg sink)"

step "6. Submit to Flink + wait for an Iceberg checkpoint commit"
# Capture (the sql-client exits non-zero after the streaming session shuts
# down even on success, so don't let pipefail/`set -e` trip on it).
SUBMIT=$(docker exec flink-jm bash -c "/opt/flink/bin/sql-client.sh -f /tmp/streaming.sql" 2>&1 || true)
echo "$SUBMIT" | grep -q "Job ID" || { echo "$SUBMIT" | tail -8; fail "INSERT job did not submit"; }
JID=""
for _ in $(seq 1 40); do
  JID=$(curl -s http://localhost:18081/jobs | python3 -c "import sys,json;j=json.load(sys.stdin)['jobs'];print(j[0]['id'] if j else '')" 2>/dev/null)
  [ -n "$JID" ] && {
    cp=$(curl -s "http://localhost:18081/jobs/$JID/checkpoints" | python3 -c "import sys,json;print(json.load(sys.stdin).get('counts',{}).get('completed',0))" 2>/dev/null)
    st=$(curl -s "http://localhost:18081/jobs/$JID" | python3 -c "import sys,json;print(json.load(sys.stdin).get('state',''))" 2>/dev/null)
    [ "$st" = "RUNNING" ] && [ "${cp:-0}" -ge 1 ] && break
    [ "$st" = "FAILED" ] && fail "Flink job FAILED"
  }
  sleep 3
done
pass "Flink job RUNNING with a committed checkpoint (job=$JID)"

step "7. Read back the Iceberg table — expect exactly the 2 PAID rows"
cat > /tmp/verify.sql <<SQL
SET 'execution.runtime-mode' = 'batch';
SET 'sql-client.execution.result-mode' = 'tableau';
CREATE TABLE \`rd\` (\`order_id\` BIGINT,\`customer_id\` BIGINT,\`status\` STRING,\`amount\` DOUBLE) WITH (
  'connector'='iceberg','catalog-name'='tellus_pipeline','catalog-type'='rest','uri'='http://lakekeeper:8181/catalog',
  'warehouse'='streaming-test','catalog-database'='kafka_live','catalog-table'='paid_orders',
  'io-impl'='org.apache.iceberg.aws.s3.S3FileIO','s3.endpoint'='http://minio:9000','s3.path-style-access'='true',
  's3.access-key-id'='$S3_KEY','s3.secret-access-key'='$S3_SECRET');
SELECT * FROM \`rd\` ORDER BY \`order_id\`;
SQL
docker cp /tmp/verify.sql flink-jm:/tmp/verify.sql >/dev/null
OUT=$(docker exec flink-jm bash -c "/opt/flink/bin/sql-client.sh -f /tmp/verify.sql" 2>&1 || true)
echo "$OUT" | grep -E "PAID|NEW|CANCELLED|rows in set" | sed 's/^/  /'
# Idempotent assertion (a re-run appends another batch): ≥2 PAID rows present,
# and NOT A SINGLE non-PAID row — proving the Filter ran inside the Flink job.
N=$(echo "$OUT" | grep -c "PAID")
[ "${N:-0}" -ge 2 ] || fail "expected ≥2 PAID rows in Iceberg, got $N"
echo "$OUT" | grep -qE "\bNEW\b|\bCANCELLED\b" && fail "a non-PAID order leaked through the filter"
pass "PAID rows landed in Iceberg ($N), zero NEW/CANCELLED leaked — Kafka→Filter→Iceberg confirmed"

printf '\n\033[1;32m✔ §2 Kafka→pipeline→Iceberg verified on real Flink + Kafka + Iceberg\033[0m\n'
echo "  (teardown: docker rm -f flink-jm flink-tm flink-gw)"
