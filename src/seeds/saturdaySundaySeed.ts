// ---------------------------------------------------------------------------
// Saturday/Sunday Seed Data Script (Task 24)
//
// Creates seed data for the features introduced on Saturday and Sunday:
//   - Sample datasets (RRA Employees, RRA Taxpayers)
//   - Sample interfaces (HasLocation, Auditable, Schedulable)
//   - Sample object type-interface implementations
//
// Idempotent: safe to run multiple times. Uses INSERT ... ON CONFLICT
// or checks for existence before creating.
//
// Prerequisites:
//   - Database migrated (npm run migrate)
//   - Base seed data present (npm run seed)
//
// Usage: npx tsx src/seeds/saturdaySundaySeed.ts
// ---------------------------------------------------------------------------

import "dotenv/config";
import { query, getClient, pool } from "../db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InterfaceDef {
  apiName: string;
  displayName: string;
  description: string;
  properties: Array<{
    apiName: string;
    displayName: string;
    baseType: string;
    isRequired: boolean;
  }>;
}

interface DatasetDef {
  name: string;
  description: string;
  sourceType: string;
  filePath: string;
  fileFormat: string;
}

interface ImplementationDef {
  objectTypeApiName: string;
  interfaceApiName: string;
  propertyMapping: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Interface Definitions
// ---------------------------------------------------------------------------

const INTERFACES: InterfaceDef[] = [
  {
    apiName: "HasLocation",
    displayName: "Has Location",
    description:
      "Interface for entities that have a geographic location. " +
      "Enables polymorphic geo queries across object types that " +
      "share location-related properties.",
    properties: [
      {
        apiName: "province",
        displayName: "Province",
        baseType: "string",
        isRequired: true,
      },
      {
        apiName: "district",
        displayName: "District",
        baseType: "string",
        isRequired: false,
      },
      {
        apiName: "sector",
        displayName: "Sector",
        baseType: "string",
        isRequired: false,
      },
    ],
  },
  {
    apiName: "Auditable",
    displayName: "Auditable",
    description:
      "Interface for entities subject to audit review. Provides a " +
      "common structure for compliance status, risk scoring, and " +
      "audit flagging across different object types.",
    properties: [
      {
        apiName: "complianceStatus",
        displayName: "Compliance Status",
        baseType: "string",
        isRequired: true,
      },
      {
        apiName: "riskScore",
        displayName: "Risk Score",
        baseType: "double",
        isRequired: false,
      },
      {
        apiName: "auditFlag",
        displayName: "Audit Flag",
        baseType: "boolean",
        isRequired: false,
      },
    ],
  },
  {
    apiName: "Schedulable",
    displayName: "Schedulable",
    description:
      "Interface for entities with temporal scheduling properties. " +
      "Enables querying across object types that have date-based " +
      "scheduling, filing, or registration periods.",
    properties: [
      {
        apiName: "effectiveDate",
        displayName: "Effective Date",
        baseType: "date",
        isRequired: true,
      },
      {
        apiName: "expirationDate",
        displayName: "Expiration Date",
        baseType: "date",
        isRequired: false,
      },
      {
        apiName: "status",
        displayName: "Status",
        baseType: "string",
        isRequired: true,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Dataset Definitions
// ---------------------------------------------------------------------------

const DATASETS: DatasetDef[] = [
  {
    name: "RRA Employee Directory",
    description:
      "Internal directory of RRA employees with department assignments, " +
      "roles, and office locations. Used for audit case assignment and " +
      "workload distribution.",
    sourceType: "csv",
    filePath: "/data/rra-employees.csv",
    fileFormat: "csv",
  },
  {
    name: "RRA Taxpayer Contacts",
    description:
      "Contact information for registered taxpayers including phone " +
      "numbers, email addresses, and mailing addresses. Linked to " +
      "the Taxpayer object type for communication workflows.",
    sourceType: "csv",
    filePath: "/data/rra-taxpayer-contacts.csv",
    fileFormat: "csv",
  },
];

// ---------------------------------------------------------------------------
// Implementation Definitions
//
// These map interface properties to existing object type properties.
// The object types must exist in the seed data (from npm run seed).
// ---------------------------------------------------------------------------

const IMPLEMENTATIONS: ImplementationDef[] = [
  {
    objectTypeApiName: "Taxpayer",
    interfaceApiName: "HasLocation",
    propertyMapping: {
      province: "province",
      sector: "sector",
      // district: not mapped — optional property
    },
  },
  {
    objectTypeApiName: "Taxpayer",
    interfaceApiName: "Auditable",
    propertyMapping: {
      complianceStatus: "complianceStatus",
      riskScore: "riskScore",
      // auditFlag: not on Taxpayer, optional
    },
  },
  {
    objectTypeApiName: "TaxReturn",
    interfaceApiName: "Auditable",
    propertyMapping: {
      complianceStatus: "status",
      auditFlag: "auditFlag",
      // riskScore: not on TaxReturn, optional
    },
  },
  {
    objectTypeApiName: "RealEstateProperty",
    interfaceApiName: "HasLocation",
    propertyMapping: {
      district: "district",
      // province: not on RealEstateProperty... skip if missing
    },
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Saturday/Sunday Seed Script (Task 24) ===\n");

  // -----------------------------------------------------------------------
  // Step 1: Find the ontology
  // -----------------------------------------------------------------------
  const ontResult = await query(
    "SELECT ontology_id FROM ontology ORDER BY created_at ASC LIMIT 1"
  );
  if (ontResult.rows.length === 0) {
    console.error(
      "ERROR: No ontology found. Run the main seed script first (npm run seed)."
    );
    process.exit(1);
  }
  const ontologyId = ontResult.rows[0].ontology_id as string;
  console.log(`Ontology: ${ontologyId}\n`);

  // -----------------------------------------------------------------------
  // Step 2: Verify existing object types
  // -----------------------------------------------------------------------
  const otResult = await query(
    "SELECT api_name FROM object_type WHERE ontology_id = $1",
    [ontologyId]
  );
  const existingObjectTypes = new Set(
    otResult.rows.map((r: Record<string, unknown>) => r.api_name as string)
  );
  console.log(
    `Existing object types: ${Array.from(existingObjectTypes).sort().join(", ")}\n`
  );

  // -----------------------------------------------------------------------
  // Step 3: Create datasets
  // -----------------------------------------------------------------------
  console.log("--- Datasets ---\n");

  // Check if the dataset table exists
  let datasetTableExists = true;
  try {
    await query("SELECT 1 FROM dataset LIMIT 0");
  } catch {
    datasetTableExists = false;
    console.warn("  WARNING: dataset table does not exist. Skipping dataset creation.\n");
  }

  if (datasetTableExists) {
    for (const ds of DATASETS) {
      try {
        // Check if already exists
        const existing = await query(
          "SELECT 1 FROM dataset WHERE name = $1",
          [ds.name]
        );

        if (existing.rows.length > 0) {
          console.log(`  EXISTS  ${ds.name}`);
          continue;
        }

        await query(
          `INSERT INTO dataset (name, description, source_type, created_by)
           VALUES ($1, $2, $3, $4)`,
          [ds.name, ds.description, ds.sourceType, "seed-script"]
        );
        console.log(`  CREATED  ${ds.name}`);
      } catch (err: any) {
        if (err.code === "23505") {
          // unique constraint violation
          console.log(`  EXISTS  ${ds.name}`);
        } else {
          console.error(`  FAILED  ${ds.name}: ${err.message}`);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 4: Create interfaces
  // -----------------------------------------------------------------------
  console.log("\n--- Interfaces ---\n");

  // Check if the interface table exists
  let interfaceTableExists = true;
  try {
    await query("SELECT 1 FROM interface LIMIT 0");
  } catch {
    interfaceTableExists = false;
    console.warn("  WARNING: interface table does not exist. Skipping interface creation.\n");
  }

  if (interfaceTableExists) {
    for (const ifDef of INTERFACES) {
      try {
        // Check if already exists
        const existing = await query(
          "SELECT interface_id FROM interface WHERE api_name = $1",
          [ifDef.apiName]
        );

        if (existing.rows.length > 0) {
          console.log(`  EXISTS  ${ifDef.apiName} (${ifDef.displayName})`);
          continue;
        }

        // Create interface with properties in a transaction
        const client = await getClient();
        try {
          await client.query("BEGIN");

          const insertResult = await client.query(
            `INSERT INTO interface (ontology_id, api_name, display_name, description)
             VALUES ($1, $2, $3, $4)
             RETURNING interface_id`,
            [ontologyId, ifDef.apiName, ifDef.displayName, ifDef.description]
          );
          const interfaceId = insertResult.rows[0].interface_id;

          // Insert properties
          for (let i = 0; i < ifDef.properties.length; i++) {
            const prop = ifDef.properties[i];
            await client.query(
              `INSERT INTO interface_property
                 (interface_id, api_name, display_name, base_type, is_required, ordinal)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [
                interfaceId,
                prop.apiName,
                prop.displayName,
                prop.baseType,
                prop.isRequired,
                i,
              ]
            );
          }

          await client.query("COMMIT");
          console.log(
            `  CREATED  ${ifDef.apiName} (${ifDef.displayName}) — ${ifDef.properties.length} properties`
          );
        } catch (txErr) {
          await client.query("ROLLBACK");
          throw txErr;
        } finally {
          client.release();
        }
      } catch (err: any) {
        if (err.code === "23505") {
          console.log(`  EXISTS  ${ifDef.apiName} (${ifDef.displayName})`);
        } else {
          console.error(
            `  FAILED  ${ifDef.apiName} (${ifDef.displayName}): ${err.message}`
          );
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: Create object type interface implementations
  // -----------------------------------------------------------------------
  console.log("\n--- Interface Implementations ---\n");

  if (interfaceTableExists) {
    for (const impl of IMPLEMENTATIONS) {
      try {
        // Verify object type exists
        if (!existingObjectTypes.has(impl.objectTypeApiName)) {
          console.log(
            `  SKIP  ${impl.objectTypeApiName} → ${impl.interfaceApiName} (object type not found)`
          );
          continue;
        }

        // Get object type ID
        const otRow = await query(
          "SELECT object_type_id FROM object_type WHERE ontology_id = $1 AND api_name = $2",
          [ontologyId, impl.objectTypeApiName]
        );
        if (otRow.rows.length === 0) {
          console.log(
            `  SKIP  ${impl.objectTypeApiName} → ${impl.interfaceApiName} (object type not in DB)`
          );
          continue;
        }
        const objectTypeId = otRow.rows[0].object_type_id;

        // Get interface ID
        const ifRow = await query(
          "SELECT interface_id FROM interface WHERE api_name = $1",
          [impl.interfaceApiName]
        );
        if (ifRow.rows.length === 0) {
          console.log(
            `  SKIP  ${impl.objectTypeApiName} → ${impl.interfaceApiName} (interface not found)`
          );
          continue;
        }
        const interfaceId = ifRow.rows[0].interface_id;

        // Check if already implemented
        const existingImpl = await query(
          "SELECT 1 FROM object_type_interface WHERE object_type_id = $1 AND interface_id = $2",
          [objectTypeId, interfaceId]
        );
        if (existingImpl.rows.length > 0) {
          console.log(
            `  EXISTS  ${impl.objectTypeApiName} → ${impl.interfaceApiName}`
          );
          continue;
        }

        // Verify property mappings — check that target properties exist
        const propResult = await query(
          "SELECT api_name FROM property WHERE object_type_id = $1",
          [objectTypeId]
        );
        const existingProps = new Set(
          propResult.rows.map((r: Record<string, unknown>) => r.api_name as string)
        );

        const validMapping: Record<string, string> = {};
        let skippedProps = 0;
        for (const [ifProp, otProp] of Object.entries(impl.propertyMapping)) {
          if (existingProps.has(otProp)) {
            validMapping[ifProp] = otProp;
          } else {
            console.log(
              `    NOTE: Skipping mapping ${ifProp} → ${otProp} (property not found on ${impl.objectTypeApiName})`
            );
            skippedProps++;
          }
        }

        if (Object.keys(validMapping).length === 0) {
          console.log(
            `  SKIP  ${impl.objectTypeApiName} → ${impl.interfaceApiName} (no valid property mappings)`
          );
          continue;
        }

        // Insert the implementation
        await query(
          `INSERT INTO object_type_interface (object_type_id, interface_id, property_mapping)
           VALUES ($1, $2, $3)`,
          [objectTypeId, interfaceId, JSON.stringify(validMapping)]
        );

        const mappingCount = Object.keys(validMapping).length;
        console.log(
          `  CREATED  ${impl.objectTypeApiName} → ${impl.interfaceApiName} ` +
          `(${mappingCount} mappings${skippedProps > 0 ? `, ${skippedProps} skipped` : ""})`
        );
      } catch (err: any) {
        if (err.code === "23505") {
          console.log(
            `  EXISTS  ${impl.objectTypeApiName} → ${impl.interfaceApiName}`
          );
        } else {
          console.error(
            `  FAILED  ${impl.objectTypeApiName} → ${impl.interfaceApiName}: ${err.message}`
          );
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log("\n--- Summary ---\n");

  if (datasetTableExists) {
    const dsCount = await query("SELECT COUNT(*)::int AS cnt FROM dataset");
    console.log(`Datasets: ${dsCount.rows[0].cnt}`);
  }

  if (interfaceTableExists) {
    const ifCount = await query(
      "SELECT COUNT(*)::int AS cnt FROM interface WHERE ontology_id = $1",
      [ontologyId]
    );
    console.log(`Interfaces: ${ifCount.rows[0].cnt}`);

    const implCount = await query(
      `SELECT COUNT(*)::int AS cnt 
       FROM object_type_interface oti
       JOIN object_type ot ON ot.object_type_id = oti.object_type_id
       WHERE ot.ontology_id = $1`,
      [ontologyId]
    );
    console.log(`Interface implementations: ${implCount.rows[0].cnt}`);

    // List implementations
    const implList = await query(
      `SELECT ot.api_name AS object_type, i.api_name AS interface
       FROM object_type_interface oti
       JOIN object_type ot ON ot.object_type_id = oti.object_type_id
       JOIN interface i ON i.interface_id = oti.interface_id
       WHERE ot.ontology_id = $1
       ORDER BY ot.api_name, i.api_name`,
      [ontologyId]
    );

    if (implList.rows.length > 0) {
      console.log("\nImplementation map:");
      for (const row of implList.rows) {
        console.log(
          `  ${(row as any).object_type} implements ${(row as any).interface}`
        );
      }
    }
  }

  console.log("\nDone.");
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main()
  .then(() => {
    pool.end();
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFATAL:", err);
    pool.end();
    process.exit(1);
  });
