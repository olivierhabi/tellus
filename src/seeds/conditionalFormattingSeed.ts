import "dotenv/config";
// ---------------------------------------------------------------------------
// conditionalFormattingSeed.ts
//
// Seeds a comprehensive, base-type-aware conditional-formatting rule set on
// EVERY property of an object type, persisting it to `property.conditional_formatting`
// (the column added by the migration). This is the backend/DB equivalent of
// the FE console seeder — the Ontology Manager and Workshop read these rules
// straight from the API.
//
// Run:
//   npx tsx src/seeds/conditionalFormattingSeed.ts [objectTypeId]
//
// Defaults to the [Olivier] Order object type.
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import { pool, query } from "../db";

const OBJECT_TYPE_ID =
  process.argv[2] || "5dab8399-b00e-4fbd-951f-1573901ef903";

type Rule = Record<string, unknown>;

const NUMERIC = new Set([
  "integer",
  "long",
  "double",
  "float",
  "number",
  "numeric",
  "decimal",
  "short",
  "byte",
]);

function mk(self: string, over: Partial<Rule>): Rule {
  return {
    id: randomUUID(),
    kind: "standard",
    conditionPropertyApiName: self,
    operator: "Is exactly",
    valueMode: "constant",
    value: "",
    valueMax: "",
    valuePropertyApiName: "",
    negate: false,
    mathLeft: "",
    mathOperator: "eq",
    mathRight: "",
    formatMode: "intent",
    intent: "success",
    color: "#238551",
    alignment: "left",
    displayContext: "table",
    ...over,
  };
}

function rulesFor(prop: { apiName: string; baseType: string }): Rule[] {
  const self = prop.apiName;
  const name = self.toLowerCase();
  const t = String(prop.baseType || "string").toLowerCase();
  const r = (over: Partial<Rule>) => mk(self, over);

  if (/status/.test(name)) {
    return [
      r({ operator: "Is exactly", value: "closed", intent: "success" }),
      r({ operator: "Is exactly", value: "open", intent: "warning" }),
      r({ operator: "Is exactly", value: "cancelled", intent: "danger" }),
      r({ kind: "always_true", formatMode: "none" }),
    ];
  }
  if (/due/.test(name) && NUMERIC.has(t)) {
    return [
      r({ kind: "math", mathLeft: "value", mathOperator: "lt", mathRight: "0", intent: "danger" }),
      r({ operator: "Numeric range", value: "0", valueMax: "7", intent: "warning" }),
      r({ kind: "always_true", intent: "success" }),
    ];
  }
  if (/quantity|qty/.test(name) && NUMERIC.has(t)) {
    return [
      r({ operator: "Numeric range", value: "0", valueMax: "25", intent: "danger" }),
      r({ operator: "Numeric range", value: "26", valueMax: "75", intent: "warning" }),
      r({ kind: "math", mathLeft: "value", mathOperator: "gt", mathRight: "90", formatMode: "hex", color: "#2d72d2" }),
    ];
  }
  if (/price|amount|cost|total/.test(name) && NUMERIC.has(t)) {
    return [
      r({ operator: "Numeric range", value: "0", valueMax: "40", formatMode: "blueprint", color: "#238551" }),
      r({ operator: "Numeric range", value: "41", valueMax: "80", formatMode: "blueprint", color: "#c87619" }),
      r({ kind: "always_true", formatMode: "blueprint", color: "#cd4246" }),
    ];
  }
  if (NUMERIC.has(t)) {
    return [
      r({ operator: "Exact numeric match", value: "0", intent: "danger" }),
      r({ kind: "math", mathLeft: "value", mathOperator: "gte", mathRight: "100", intent: "success" }),
    ];
  }
  if (t === "boolean") {
    return [
      r({ operator: "Is true", intent: "success" }),
      r({ operator: "Is false", intent: "danger" }),
    ];
  }
  if (/assignee|owner|user/.test(name)) {
    return [
      r({ operator: "Is null", intent: "danger" }),
      r({ operator: "Contains", value: "Koss", formatMode: "hex", color: "#147eb3" }),
    ];
  }
  if (/name|item|title/.test(name)) {
    return [
      r({ operator: "Starts with", value: "Office", formatMode: "blueprint", color: "#7961db" }),
      r({ operator: "Contains", value: "Monitor", formatMode: "hex", color: "#2965cc" }),
    ];
  }
  if (/date/.test(name)) {
    return [
      r({ operator: "Contains", value: "/23", formatMode: "blueprint", color: "#2965cc" }),
    ];
  }
  return [r({ operator: "Is null", intent: "danger" })];
}

async function main() {
  const ot = await query(
    "SELECT object_type_id, api_name FROM object_type WHERE object_type_id = $1",
    [OBJECT_TYPE_ID],
  );
  if (ot.rows.length === 0) {
    throw new Error(`Object type ${OBJECT_TYPE_ID} not found`);
  }
  const apiName = ot.rows[0].api_name as string;

  const props = await query(
    "SELECT api_name, base_type FROM property WHERE object_type_id = $1 ORDER BY ordinal, api_name",
    [OBJECT_TYPE_ID],
  );
  if (props.rows.length === 0) {
    throw new Error("No properties found for this object type");
  }

  let total = 0;
  for (const p of props.rows as Array<{ api_name: string; base_type: string }>) {
    const rules = rulesFor({ apiName: p.api_name, baseType: p.base_type });
    await query(
      "UPDATE property SET conditional_formatting = $1 WHERE object_type_id = $2 AND api_name = $3",
      [JSON.stringify(rules), OBJECT_TYPE_ID, p.api_name],
    );
    total += rules.length;
    console.log(`  ${p.api_name} (${p.base_type}) ← ${rules.length} rule(s)`);
  }

  console.log(
    `\n✅ Seeded ${total} conditional-formatting rules across ${props.rows.length} properties of "${apiName}".`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
