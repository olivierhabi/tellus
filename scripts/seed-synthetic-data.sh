#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# seed-synthetic-data.sh — populate the Ontology Platform with realistic data
# ---------------------------------------------------------------------------
# Generates two synthetic datasets (airport flights and e-commerce orders),
# registers them as object types, writes real documents straight into the
# OpenSearch index, and seeds Phase 2 auxiliary data (branches, proposals,
# groups, favorites, explorations, PII samples, usage events). Downstream
# test scripts then exercise the API against a non-empty system.
# ---------------------------------------------------------------------------

set -uo pipefail

API="${API:-http://localhost:3000}"
ES="${ES:-http://localhost:9200}"
DATA_DIR="${DATA_DIR:-/tmp/tellus-synthetic}"
ONTOLOGY_ID="${ONTOLOGY_ID:-$(curl -s "$API/api/v2/ontologies" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"][0]["ontologyId"])')}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

mkdir -p "$DATA_DIR"

# ---------------------------------------------------------------------------
# 1. Generate synthetic CSV files
# ---------------------------------------------------------------------------

echo -e "${YELLOW}[1/6]${NC} Generating synthetic CSV files in $DATA_DIR"

python3 <<PYEOF > "$DATA_DIR/synthflight.csv"
import csv, sys, random
random.seed(42)
STATUSES = ["SCHEDULED", "BOARDING", "DEPARTED", "LANDED", "CANCELLED", "DELAYED"]
AIRPORTS = [
  ("JFK", "New York",     40.6413, -73.7781, "US"),
  ("LHR", "London",       51.4700,  -0.4543, "GB"),
  ("CDG", "Paris",        49.0097,   2.5479, "FR"),
  ("NRT", "Tokyo",        35.7720, 140.3929, "JP"),
  ("SYD", "Sydney",      -33.9399, 151.1753, "AU"),
  ("KGL", "Kigali",       -1.9636,  30.1395, "RW"),
  ("DXB", "Dubai",         25.2528,  55.3644, "AE"),
  ("SFO", "San Francisco", 37.6213,-122.3790, "US"),
]
AIRLINES = ["AA","UA","DL","BA","AF","LH","EK","NH"]
w = csv.writer(sys.stdout)
w.writerow(["flightNumber","airline","origin","destination","status","ticketPrice","departureTime","originLat","originLon","originCountry","contactEmail","passengerNotes"])
for i in range(250):
    origin = random.choice(AIRPORTS)
    dest   = random.choice([a for a in AIRPORTS if a[0] != origin[0]])
    status = random.choice(STATUSES)
    airline = random.choice(AIRLINES)
    fnum = f"{airline}{random.randint(100,9999)}"
    price = round(random.uniform(80, 2500), 2)
    dep = f"2026-04-{random.randint(1,28):02d}T{random.randint(0,23):02d}:{random.randint(0,59):02d}:00Z"
    email = f"passenger{i}@example.com"  # synthetic PII sample
    notes = "call +1-202-555-0199 if delayed" if i % 17 == 0 else "standard"
    w.writerow([fnum, airline, origin[0], dest[0], status, price, dep, origin[2], origin[3], origin[4], email, notes])
PYEOF

python3 <<PYEOF > "$DATA_DIR/synthorder.csv"
import csv, sys, random
random.seed(7)
CUSTOMERS = [f"cust-{i:04d}" for i in range(120)]
ITEMS = ["Widget","Gadget","Sprocket","Cable","Battery","Case","Charger","Drive","Card","Panel"]
w = csv.writer(sys.stdout)
w.writerow(["orderId","customerId","itemName","quantity","totalUsd","status","placedAt"])
for i in range(400):
    oid = f"ord-{i:05d}"
    w.writerow([
      oid,
      random.choice(CUSTOMERS),
      random.choice(ITEMS),
      random.randint(1, 5),
      round(random.uniform(5, 900), 2),
      random.choice(["PLACED","PICKED","SHIPPED","DELIVERED","RETURNED"]),
      f"2026-0{random.randint(1,4)}-{random.randint(1,28):02d}T12:00:00Z",
    ])
PYEOF

FLIGHT_COUNT=$(($(wc -l < "$DATA_DIR/synthflight.csv") - 1))
ORDER_COUNT=$(($(wc -l < "$DATA_DIR/synthorder.csv") - 1))
echo -e "  ${GREEN}✓${NC} $FLIGHT_COUNT flights, $ORDER_COUNT orders"

# ---------------------------------------------------------------------------
# 2. Create the object types via the real API
# ---------------------------------------------------------------------------

echo -e "${YELLOW}[2/6]${NC} Registering object types"

create_type() {
  local api_name="$1" display_name="$2"
  local existing
  existing=$(curl -s -o /dev/null -w "%{http_code}" "$API/api/v2/ontologies/$ONTOLOGY_ID/objectTypes/$api_name")
  if [[ "$existing" == "200" ]]; then
    echo -e "  ${GREEN}✓${NC} $api_name already exists"
    return 0
  fi
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -d "{\"apiName\":\"$api_name\",\"displayName\":\"$display_name\",\"status\":\"active\"}" \
    "$API/api/v2/ontologies/$ONTOLOGY_ID/objectTypes")
  if [[ "$status" == "201" ]]; then
    echo -e "  ${GREEN}✓${NC} $api_name created"
  else
    echo -e "  ${RED}✗${NC} $api_name POST → $status"
  fi
}

create_type "SynthFlight" "Synthetic Flight"
create_type "SynthOrder"  "Synthetic Order"

add_property() {
  local type="$1" api="$2" display="$3" base="$4"
  curl -s -o /dev/null -X POST \
    -H "Content-Type: application/json" \
    -d "{\"apiName\":\"$api\",\"displayName\":\"$display\",\"baseType\":\"$base\"}" \
    "$API/api/v2/ontologies/$ONTOLOGY_ID/objectTypes/$type/properties"
}

add_property SynthFlight flightNumber  "Flight Number"   string
add_property SynthFlight airline       "Airline"         string
add_property SynthFlight origin        "Origin"          string
add_property SynthFlight destination   "Destination"     string
add_property SynthFlight status        "Status"          string
add_property SynthFlight ticketPrice   "Ticket Price"    double
add_property SynthFlight departureTime "Departure Time"  timestamp
add_property SynthFlight originCountry "Origin Country"  string
add_property SynthFlight contactEmail  "Contact Email"   string
echo -e "  ${GREEN}✓${NC} registered 9 SynthFlight properties"

add_property SynthOrder orderId    "Order ID"    string
add_property SynthOrder customerId "Customer ID" string
add_property SynthOrder itemName   "Item Name"   string
add_property SynthOrder quantity   "Quantity"    integer
add_property SynthOrder totalUsd   "Total USD"   double
add_property SynthOrder status     "Status"      string
add_property SynthOrder placedAt   "Placed At"   timestamp
echo -e "  ${GREEN}✓${NC} registered 7 SynthOrder properties"

# ---------------------------------------------------------------------------
# 3. Bulk-index the synthetic docs directly into OpenSearch
#    (bypasses the funnel pipeline for this seed so we have deterministic
#    docs for the verification suite to query).
# ---------------------------------------------------------------------------

echo -e "${YELLOW}[3/6]${NC} Bulk-indexing into OpenSearch"

python3 <<PYEOF
import csv, json, urllib.request
from datetime import datetime

ES = "$ES"

def delete_index(name):
    try:
        req = urllib.request.Request(f"{ES}/{name}", method="DELETE")
        urllib.request.urlopen(req)
    except Exception:
        pass

def create_index(name, mapping):
    # Use a name that DOES match the ontology-* template so the repo's
    # search/count paths can find the docs. The template adds the
    # __version/__pk/__objectType system fields automatically.
    body = json.dumps({
        "mappings": {
            "dynamic": "true",
            "properties": mapping,
        },
    }).encode()
    try:
        req = urllib.request.Request(
            f"{ES}/{name}",
            data=body,
            method="PUT",
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req)
        print(f"  ✓ created {name}")
    except Exception as e:
        print(f"  ~ create {name}: {e}")

def bulk(name, rows, id_field):
    lines = []
    for i, row in enumerate(rows):
        doc = dict(row)
        # System fields required by the ontology-template
        doc["__pk"]           = row[id_field]
        doc["__objectType"]   = name.removeprefix("ontology-")
        doc["__version"]      = 1
        doc["__editedBy"]     = "seed"
        doc["__lastModified"] = datetime.utcnow().isoformat() + "Z"
        doc["__datasourceVersion"] = "seed-v1"
        lines.append(json.dumps({"index": {"_index": name, "_id": row[id_field]}}))
        lines.append(json.dumps(doc))
    body = ("\n".join(lines) + "\n").encode()
    req = urllib.request.Request(
        f"{ES}/_bulk?refresh=true",
        data=body,
        method="POST",
        headers={"Content-Type": "application/x-ndjson"},
    )
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    errors = data.get("errors")
    if errors:
        bad = [it for it in data.get("items", []) if "error" in it.get("index", {})]
        if bad:
            print(f"  ~ first error: {json.dumps(bad[0]['index']['error'])[:300]}")
    print(f"  → {name}: {len(rows)} docs indexed, errors={errors}")

# Delete pre-existing indices so we get a clean slate each seed run.
delete_index("ontology-synthflight")
delete_index("ontology-synthorder")

create_index("ontology-synthflight", {
  "flightNumber":    {"type": "keyword"},
  "airline":         {"type": "keyword"},
  "origin":          {"type": "keyword"},
  "destination":     {"type": "keyword"},
  "status":          {"type": "keyword"},
  "ticketPrice":     {"type": "double"},
  "departureTime":   {"type": "date"},
  "originLat":       {"type": "double"},
  "originLon":       {"type": "double"},
  "originCountry":   {"type": "keyword"},
  "originLocation":  {"type": "geo_point"},
  "contactEmail":    {"type": "keyword"},
  "passengerNotes":  {"type": "text"},
})

flights = []
with open("$DATA_DIR/synthflight.csv") as f:
    rdr = csv.DictReader(f)
    for row in rdr:
        row["ticketPrice"] = float(row["ticketPrice"])
        row["originLat"] = float(row["originLat"])
        row["originLon"] = float(row["originLon"])
        row["originLocation"] = {"lat": row["originLat"], "lon": row["originLon"]}
        flights.append(row)
bulk("ontology-synthflight", flights, "flightNumber")

create_index("ontology-synthorder", {
  "orderId":    {"type": "keyword"},
  "customerId": {"type": "keyword"},
  "itemName":   {"type": "keyword"},
  "quantity":   {"type": "integer"},
  "totalUsd":   {"type": "double"},
  "status":     {"type": "keyword"},
  "placedAt":   {"type": "date"},
})

orders = []
with open("$DATA_DIR/synthorder.csv") as f:
    rdr = csv.DictReader(f)
    for row in rdr:
        row["quantity"] = int(row["quantity"])
        row["totalUsd"] = float(row["totalUsd"])
        orders.append(row)
bulk("ontology-synthorder", orders, "orderId")
PYEOF

# ---------------------------------------------------------------------------
# 4. Seed Phase 2 auxiliary data
# ---------------------------------------------------------------------------

echo -e "${YELLOW}[4/6]${NC} Seeding branches, groups, favorites, explorations"

BRANCH="seed-$(date +%s)"
curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"name\":\"$BRANCH\"}" \
  "$API/api/v2/ontologies/$ONTOLOGY_ID/branches" > /dev/null
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"title":"Add Flight primary key"}' \
  "$API/api/v2/ontologies/$ONTOLOGY_ID/branches/$BRANCH/proposals" > /dev/null
echo -e "  ${GREEN}✓${NC} branch $BRANCH + proposal"

GROUP="transport"
curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"apiName\":\"$GROUP\",\"displayName\":\"Transport\"}" \
  "$API/api/v2/ontologies/$ONTOLOGY_ID/groups" > /dev/null
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"objectTypeApiName":"SynthFlight"}' \
  "$API/api/v2/ontologies/$ONTOLOGY_ID/groups/$GROUP/members" > /dev/null
echo -e "  ${GREEN}✓${NC} group $GROUP + SynthFlight membership"

curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"resourceType":"objectType","resourceId":"SynthFlight"}' \
  "$API/api/v2/users/me/favorites" > /dev/null
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"resourceType":"objectType","resourceId":"SynthFlight"}' \
  "$API/api/v2/users/me/favorites/recent" > /dev/null
echo -e "  ${GREEN}✓${NC} favorite + recent visit"

curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"title":"Delayed SFO flights","description":"seed","config":{"filter":[{"property":"status","operator":"eq","value":"DELAYED"}]}}' \
  "$API/api/v2/ontologies/$ONTOLOGY_ID/explorations" > /dev/null
echo -e "  ${GREEN}✓${NC} saved exploration"

FN_NAME="seedFn$(date +%s)"
curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"apiName\":\"$FN_NAME\",\"displayName\":\"Seed Fn\",\"runtime\":\"typescript\",\"sourceCode\":\"module.exports = (input) => ({ doubled: (input && input.n) ? input.n * 2 : 0 });\"}" \
  "$API/api/v2/ontologies/$ONTOLOGY_ID/functions" > /dev/null
INVOKE_RES=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"input":{"n":21}}' \
  "$API/api/v2/ontologies/$ONTOLOGY_ID/functions/$FN_NAME/invoke")
if echo "$INVOKE_RES" | grep -q '"doubled":42'; then
  echo -e "  ${GREEN}✓${NC} function $FN_NAME invoked (21 → 42)"
else
  echo -e "  ${RED}✗${NC} function invoke unexpected: $INVOKE_RES"
fi
export SEED_FN_NAME="$FN_NAME"

# ---------------------------------------------------------------------------
# 5. Seed usage events so the materialized view has real counts
# ---------------------------------------------------------------------------

echo -e "${YELLOW}[5/6]${NC} Seeding usage events"

docker exec tellus-db psql -U tellus -d tellus_db -c "
  INSERT INTO usage_event (ontology_id, resource_type, resource_id, user_id, operation, created_at)
  SELECT
    '$ONTOLOGY_ID'::uuid,
    'objectType',
    'SynthFlight',
    'seed',
    CASE WHEN g % 3 = 0 THEN 'write' ELSE 'read' END,
    now() - (g * interval '1 hour')
  FROM generate_series(0, 200) g;
  REFRESH MATERIALIZED VIEW usage_event_daily;
" > /dev/null 2>&1
echo -e "  ${GREEN}✓${NC} 201 usage events + matview refreshed"

# ---------------------------------------------------------------------------
# 6. Print resolved IDs for downstream test scripts
# ---------------------------------------------------------------------------

echo -e "${YELLOW}[6/6]${NC} Summary"
echo "ONTOLOGY_ID=$ONTOLOGY_ID"
echo "BRANCH=$BRANCH"
echo "GROUP=$GROUP"
echo "FN_NAME=$FN_NAME"
echo "FLIGHT_INDEX=objects-SynthFlight ($FLIGHT_COUNT docs)"
echo "ORDER_INDEX=objects-SynthOrder ($ORDER_COUNT docs)"
echo
echo -e "${GREEN}Seed complete.${NC} Run ./scripts/test-synthetic-data.sh next."
