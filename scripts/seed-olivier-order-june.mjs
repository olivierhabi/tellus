// ---------------------------------------------------------------------------
// seed-olivier-order-june.mjs
//
// Idempotent seed for the Workshop demo object type `OlivierOrderJune` so the
// editor at /workshop/{rid} (whose module points at the ontology below) both
// resolves a real schema (no ObjectTypeNotFound 404) and renders real rows /
// facet counts through the B05 _load and B08 _aggregate endpoints.
//
// What it does (all steps are safe to re-run):
//   1. Mint a Keycloak access token (password grant — bypasses the FE passkey
//      enrollment gate, same mechanism the Cypress suite uses).
//   2. Create the `OlivierOrderJune` object type (camelCase properties) in the
//      target ontology via POST /objectTypes/batch — skipped if it exists.
//   3. Upsert N object_instances rows on the ontology's `main` branch with
//      camelCase property keys that match the object type's api names, so the
//      generic PostgresOssAdapter (`properties ->> '<apiName>'`) reads them.
//
// Config via env (all have dev defaults):
//   API_BASE, KC_URL, KC_REALM, CLIENT_ID, CLIENT_SECRET, SEED_USER,
//   SEED_PASS, ONTOLOGY_ID, POSTGRES_URL, ROW_COUNT
//
// Usage:  node scripts/seed-olivier-order-june.mjs
// ---------------------------------------------------------------------------

import pg from "pg";

const API_BASE = process.env.API_BASE ?? "http://localhost:3000/api";
const KC_URL = process.env.KC_URL ?? "http://localhost:8086";
const KC_REALM = process.env.KC_REALM ?? "tellus";
const CLIENT_ID = process.env.CLIENT_ID ?? "tellus-confidential";
const CLIENT_SECRET =
  process.env.CLIENT_SECRET ?? "tellus-confidential-secret-change-me";
const SEED_USER = process.env.SEED_USER ?? "cypress@tellus.local";
const SEED_PASS = process.env.SEED_PASS ?? "Password123!";
const ONTOLOGY_ID = process.env.ONTOLOGY_ID ?? "49aaa226-40f3-4516-bd0e-8c3010bd3edd";
const POSTGRES_URL =
  process.env.POSTGRES_URL ?? "postgresql://tellus:tellus123@localhost:5432/tellus_db";
const ROW_COUNT = Number(process.env.ROW_COUNT ?? 20);

const TYPE = "OlivierOrderJune";

const PROPERTIES = [
  { apiName: "id", displayName: "Order ID", baseType: "string", isRequired: true, ordinal: 0 },
  { apiName: "itemName", displayName: "Item Name", baseType: "string", isRequired: true, ordinal: 1 },
  { apiName: "orderDueDate", displayName: "Order Due Date", baseType: "timestamp", ordinal: 2 },
  { apiName: "customerId", displayName: "Customer ID", baseType: "string", ordinal: 3 },
  { apiName: "status", displayName: "Status", baseType: "string", ordinal: 4 },
  { apiName: "assignee", displayName: "Assignee", baseType: "string", ordinal: 5 },
  { apiName: "quantity", displayName: "Quantity", baseType: "integer", ordinal: 6 },
];

const ITEMS = [
  "Printer", "Office Desk", "Stapler", "Monitor", "Keyboard", "Mouse",
  "Office Chair", "A4 Paper", "Desk Lamp", "Whiteboard", "Laptop Stand",
  "Webcam", "Headset", "Cable Organizer", "Notebook", "USB Hub", "Desk Mat",
  "Monitor Arm", "Footrest", "Power Strip",
];
const STATUSES = ["open", "assigned", "in_review", "done"];
const ASSIGNEES = ["Alice", "Bob", "Carol", null];

const log = (...a) => console.log("[seed]", ...a);
const fail = (m) => { console.error("[seed] FAIL:", m); process.exit(1); };

async function token() {
  const res = await fetch(
    `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        username: SEED_USER,
        password: SEED_PASS,
        scope: "openid profile email",
      }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    fail(`token request failed (${res.status}): ${body.error_description ?? body.error ?? "no token"}`);
  }
  return body.access_token;
}

async function ensureObjectType(tok) {
  const headers = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };
  const get = await fetch(
    `${API_BASE}/v1/ontology/${ONTOLOGY_ID}/objectTypes/${TYPE}`,
    { headers },
  );
  if (get.ok) {
    log(`object type ${TYPE} already exists — skipping create`);
    return;
  }
  if (get.status !== 404) {
    fail(`unexpected status checking object type: ${get.status}`);
  }
  const create = await fetch(
    `${API_BASE}/v1/ontology/${ONTOLOGY_ID}/objectTypes/batch`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        apiName: TYPE,
        displayName: "Olivier Order June",
        description: "June orders (Workshop demo object type)",
        status: "active",
        onConflict: "fail",
        primaryKeyProperty: "id",
        titleProperty: "itemName",
        properties: PROPERTIES,
      }),
    },
  );
  if (!create.ok) {
    const b = await create.text();
    fail(`object type create failed (${create.status}): ${b.slice(0, 300)}`);
  }
  log(`object type ${TYPE} created`);
}

async function seedRows() {
  const client = new pg.Client({ connectionString: POSTGRES_URL });
  await client.connect();
  try {
    const br = await client.query(
      `SELECT branch_id FROM ontology_branch WHERE ontology_id = $1::uuid AND name = 'main'`,
      [ONTOLOGY_ID],
    );
    if (!br.rows[0]) fail(`no main branch for ontology ${ONTOLOGY_ID}`);
    const branchId = br.rows[0].branch_id;

    for (let i = 0; i < ROW_COUNT; i++) {
      const pk = `ORD-${String(i + 1).padStart(3, "0")}`;
      const props = {
        id: pk,
        // Older dev ontologies created this demo type with `orderId` as the
        // canonical property. Keep both aliases populated so the idempotent
        // scale seed remains compatible with either schema revision.
        orderId: pk,
        itemName: ITEMS[i % ITEMS.length],
        orderDueDate: new Date(Date.UTC(2023, 5, 1 + (i % 28), 12, 0, 0)).toISOString(),
        customerId: `cust-${String((i % 5) + 1).padStart(3, "0")}`,
        status: STATUSES[i % STATUSES.length],
        assignee: ASSIGNEES[i % ASSIGNEES.length],
        quantity: (i + 1) * 5,
      };
      await client.query(
        `INSERT INTO object_instances
           (ontology_id, branch_id, object_type_api_name, primary_key, properties, markings, last_modified_at, version)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, ARRAY[]::text[], now(), 1)
         ON CONFLICT (ontology_id, branch_id, object_type_api_name, primary_key)
         DO UPDATE SET properties = EXCLUDED.properties, last_modified_at = now(),
                       version = object_instances.version + 1`,
        [ONTOLOGY_ID, branchId, TYPE, pk, JSON.stringify(props)],
      );
    }
    const tot = await client.query(
      `SELECT count(*)::int AS c FROM object_instances WHERE ontology_id = $1::uuid AND object_type_api_name = $2`,
      [ONTOLOGY_ID, TYPE],
    );
    const total = tot.rows[0].c;

    // Reflect the row count in the catalogue's "N objects" readout. The
    // object-types LIST surfaces `funnel_state.objects_indexed`; a direct
    // object_instances seed bypasses the funnel, so we set it explicitly so
    // the Workshop inspector's "Current value" shows the real count instead
    // of 0. Best-effort: skip quietly if the type has no funnel_state row.
    const otRow = await client.query(
      `SELECT object_type_id FROM object_type WHERE ontology_id = $1::uuid AND api_name = $2`,
      [ONTOLOGY_ID, TYPE],
    );
    if (otRow.rows[0]) {
      await client.query(
        `UPDATE funnel_state
            SET objects_indexed = $1, status = 'indexed',
                last_indexed_at = now(), updated_at = now()
          WHERE object_type_id = $2`,
        [total, otRow.rows[0].object_type_id],
      );
    }
    log(`upserted ${ROW_COUNT} rows on branch ${branchId} — ${total} total for ${TYPE} (catalogue count synced)`);
  } finally {
    await client.end();
  }
}

(async () => {
  log(`ontology=${ONTOLOGY_ID} type=${TYPE} rows=${ROW_COUNT}`);
  const tok = await token();
  await ensureObjectType(tok);
  await seedRows();
  log("done ✓");
})().catch((e) => fail(e.message));
