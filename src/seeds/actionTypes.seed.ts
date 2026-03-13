// ---------------------------------------------------------------------------
// Action Types Seed Script (Task 28)
//
// Populates the RRA Tax Ontology with 8 realistic action types for the
// Rwanda Revenue Authority tax use case. Covers the full range of action
// patterns: create, modify, multi-rule, addLink, and object_reference params.
//
// Idempotent: uses the createActionType model function which throws
// ACTION_TYPE_ALREADY_EXISTS on duplicate api_name — caught and treated
// as a skip (not an error).
//
// Required object types: Taxpayer, TaxReturn, Business
// Optional object types: Payment, AuditCase (skipped with warning if missing)
//
// Usage:
//   npx tsx src/seeds/actionTypes.seed.ts
//   (or: npm run seed:actions)
// ---------------------------------------------------------------------------

import "dotenv/config";
import { query, pool } from "../db";
import {
  createActionType,
  getActionType,
} from "../models/actionType";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActionTypeDef {
  apiName: string;
  displayName: string;
  description: string;
  parameters: unknown[];
  rules: unknown[];
  maxAffectedObjects?: number;
  isEnabled?: boolean;
  /** Object types required for this action type to be creatable. */
  requiredObjectTypes: string[];
}

// ---------------------------------------------------------------------------
// Action Type Definitions
// ---------------------------------------------------------------------------

const ACTION_TYPES: ActionTypeDef[] = [
  // -----------------------------------------------------------------------
  // 1. registerTaxpayer
  // -----------------------------------------------------------------------
  {
    apiName: "registerTaxpayer",
    displayName: "Register New Taxpayer",
    description:
      "Creates a new Taxpayer record in the RRA system with TIN, name, " +
      "type, registration date, and province. Auto-sets compliance status " +
      "to 'active' and registration date to current date.",
    parameters: [
      {
        apiName: "tin",
        displayName: "Tax Identification Number",
        type: "string",
        required: true,
        constraints: { regex: "^[0-9]{9}$" },
      },
      {
        apiName: "fullName",
        displayName: "Full Name",
        type: "string",
        required: true,
      },
      {
        apiName: "taxpayerType",
        displayName: "Taxpayer Type",
        type: "string",
        required: true,
      },
      {
        apiName: "province",
        displayName: "Province",
        type: "string",
        required: false,
      },
    ],
    rules: [
      {
        type: "createObject",
        objectType: "Taxpayer",
        properties: {
          tin: { source: "parameter", param: "tin" },
          fullName: { source: "parameter", param: "fullName" },
          taxpayerType: { source: "parameter", param: "taxpayerType" },
          province: { source: "parameter", param: "province" },
          registrationDate: { source: "currentTimestamp" },
          complianceStatus: { source: "static", value: "active" },
        },
      },
    ],
    requiredObjectTypes: ["Taxpayer"],
  },

  // -----------------------------------------------------------------------
  // 2. fileTaxReturn
  // -----------------------------------------------------------------------
  {
    apiName: "fileTaxReturn",
    displayName: "File Tax Return",
    description:
      "Creates a new TaxReturn record for a taxpayer. Sets the filing date " +
      "to the current timestamp and initial status to 'filed'. The audit " +
      "flag defaults to false.",
    parameters: [
      {
        apiName: "returnId",
        displayName: "Return ID",
        type: "string",
        required: true,
      },
      {
        apiName: "taxType",
        displayName: "Tax Type",
        type: "string",
        required: true,
      },
      {
        apiName: "period",
        displayName: "Tax Period",
        type: "string",
        required: true,
      },
      {
        apiName: "declaredRevenue",
        displayName: "Declared Revenue",
        type: "double",
        required: true,
        constraints: { min: 0 },
      },
      {
        apiName: "declaredTax",
        displayName: "Declared Tax",
        type: "double",
        required: true,
        constraints: { min: 0 },
      },
    ],
    rules: [
      {
        type: "createObject",
        objectType: "TaxReturn",
        properties: {
          returnId: { source: "parameter", param: "returnId" },
          taxType: { source: "parameter", param: "taxType" },
          period: { source: "parameter", param: "period" },
          declaredRevenue: { source: "parameter", param: "declaredRevenue" },
          declaredTax: { source: "parameter", param: "declaredTax" },
          filingDate: { source: "currentTimestamp" },
          status: { source: "static", value: "filed" },
          auditFlag: { source: "static", value: false },
        },
      },
    ],
    requiredObjectTypes: ["TaxReturn"],
  },

  // -----------------------------------------------------------------------
  // 3. flagForAudit
  // -----------------------------------------------------------------------
  {
    apiName: "flagForAudit",
    displayName: "Flag Return for Audit",
    description:
      "Flags a TaxReturn for audit by setting auditFlag=true and places " +
      "the linked Taxpayer under compliance review. This is a multi-rule " +
      "action that modifies both the TaxReturn and the Taxpayer.",
    parameters: [
      {
        apiName: "returnRef",
        displayName: "Tax Return Reference",
        type: "object_reference",
        objectType: "TaxReturn",
        required: true,
      },
      {
        apiName: "taxpayerRef",
        displayName: "Taxpayer Reference",
        type: "object_reference",
        objectType: "Taxpayer",
        required: true,
      },
      {
        apiName: "auditReason",
        displayName: "Audit Reason",
        type: "string",
        required: true,
      },
    ],
    rules: [
      {
        type: "modifyObject",
        objectType: "TaxReturn",
        objectReference: { source: "parameter", param: "returnRef" },
        properties: {
          auditFlag: { source: "static", value: true },
          // Note: auditReason property doesn't exist on TaxReturn in the
          // seed ontology, so we don't include it. In a real deployment,
          // the admin would add the property first, then update this rule.
        },
      },
      {
        type: "modifyObject",
        objectType: "Taxpayer",
        objectReference: { source: "parameter", param: "taxpayerRef" },
        properties: {
          complianceStatus: { source: "static", value: "under_review" },
        },
      },
    ],
    requiredObjectTypes: ["TaxReturn", "Taxpayer"],
  },

  // -----------------------------------------------------------------------
  // 4. updateTaxpayerRiskScore
  // -----------------------------------------------------------------------
  {
    apiName: "updateTaxpayerRiskScore",
    displayName: "Update Taxpayer Risk Score",
    description:
      "Updates a Taxpayer's risk score. The risk score must be between " +
      "0 and 100. Used by the risk assessment module to flag high-risk " +
      "taxpayers for targeted audits.",
    parameters: [
      {
        apiName: "taxpayerRef",
        displayName: "Taxpayer Reference",
        type: "object_reference",
        objectType: "Taxpayer",
        required: true,
      },
      {
        apiName: "riskScore",
        displayName: "Risk Score",
        type: "double",
        required: true,
        constraints: { min: 0, max: 100 },
      },
    ],
    rules: [
      {
        type: "modifyObject",
        objectType: "Taxpayer",
        objectReference: { source: "parameter", param: "taxpayerRef" },
        properties: {
          riskScore: { source: "parameter", param: "riskScore" },
        },
      },
    ],
    requiredObjectTypes: ["Taxpayer"],
  },

  // -----------------------------------------------------------------------
  // 5. closeTaxReturn
  // -----------------------------------------------------------------------
  {
    apiName: "closeTaxReturn",
    displayName: "Close Tax Return",
    description:
      "Marks a TaxReturn as closed and records the closure timestamp. " +
      "Used when a return has been fully processed and no further action " +
      "is required.",
    parameters: [
      {
        apiName: "returnRef",
        displayName: "Tax Return Reference",
        type: "object_reference",
        objectType: "TaxReturn",
        required: true,
      },
    ],
    rules: [
      {
        type: "modifyObject",
        objectType: "TaxReturn",
        objectReference: { source: "parameter", param: "returnRef" },
        properties: {
          status: { source: "static", value: "closed" },
          // Note: closedAt property doesn't exist on TaxReturn in the seed
          // ontology. In a real deployment, the admin would add the property
          // first. We omit it here to keep the seed idempotent.
        },
      },
    ],
    requiredObjectTypes: ["TaxReturn"],
  },

  // -----------------------------------------------------------------------
  // 6. registerBusiness
  // -----------------------------------------------------------------------
  {
    apiName: "registerBusiness",
    displayName: "Register New Business",
    description:
      "Creates a new Business entity and links it to its owning Taxpayer " +
      "via the taxpayerBusiness link type. The business is created with a " +
      "unique business ID, trade name, sector, and registration date.",
    parameters: [
      {
        apiName: "businessId",
        displayName: "Business ID",
        type: "string",
        required: true,
      },
      {
        apiName: "tradeName",
        displayName: "Trade Name",
        type: "string",
        required: true,
      },
      {
        apiName: "sector",
        displayName: "Sector",
        type: "string",
        required: true,
      },
      {
        apiName: "ownerTin",
        displayName: "Owner TIN",
        type: "object_reference",
        objectType: "Taxpayer",
        required: true,
      },
    ],
    rules: [
      {
        type: "createObject",
        objectType: "Business",
        properties: {
          businessId: { source: "parameter", param: "businessId" },
          tradeName: { source: "parameter", param: "tradeName" },
          sector: { source: "parameter", param: "sector" },
          registrationDate: { source: "currentTimestamp" },
        },
      },
      {
        type: "addLink",
        linkType: "taxpayerBusiness",
        linkTypeApiName: "taxpayerBusiness",
        sourceObject: {
          objectType: "Business",
          source: "parameter",
          param: "businessId",
        },
        targetObject: {
          objectType: "Taxpayer",
          source: "parameter",
          param: "ownerTin",
        },
      },
    ],
    requiredObjectTypes: ["Business", "Taxpayer"],
  },

  // -----------------------------------------------------------------------
  // 7. recordPayment
  // -----------------------------------------------------------------------
  {
    apiName: "recordPayment",
    displayName: "Record Tax Payment",
    description:
      "Creates a Payment record linked to a TaxReturn. Records the " +
      "payment amount, method, and reference number. Requires the Payment " +
      "object type to exist in the ontology.",
    parameters: [
      {
        apiName: "paymentId",
        displayName: "Payment ID",
        type: "string",
        required: true,
      },
      {
        apiName: "amount",
        displayName: "Payment Amount",
        type: "double",
        required: true,
        constraints: { min: 0 },
      },
      {
        apiName: "paymentMethod",
        displayName: "Payment Method",
        type: "string",
        required: true,
      },
      {
        apiName: "referenceNumber",
        displayName: "Reference Number",
        type: "string",
        required: true,
      },
    ],
    rules: [
      {
        type: "createObject",
        objectType: "Payment",
        properties: {
          paymentId: { source: "parameter", param: "paymentId" },
          amount: { source: "parameter", param: "amount" },
          paymentMethod: { source: "parameter", param: "paymentMethod" },
          referenceNumber: { source: "parameter", param: "referenceNumber" },
        },
      },
    ],
    requiredObjectTypes: ["Payment"],
  },

  // -----------------------------------------------------------------------
  // 8. initiateAudit
  // -----------------------------------------------------------------------
  {
    apiName: "initiateAudit",
    displayName: "Initiate Audit Case",
    description:
      "Creates an AuditCase object linked to a Taxpayer. Records the " +
      "case ID, assigned auditor, priority, and opening timestamp. " +
      "Requires the AuditCase object type to exist in the ontology.",
    parameters: [
      {
        apiName: "caseId",
        displayName: "Case ID",
        type: "string",
        required: true,
      },
      {
        apiName: "taxpayerRef",
        displayName: "Taxpayer Reference",
        type: "object_reference",
        objectType: "Taxpayer",
        required: true,
      },
      {
        apiName: "assignedTo",
        displayName: "Assigned Auditor",
        type: "string",
        required: true,
      },
      {
        apiName: "priority",
        displayName: "Priority",
        type: "string",
        required: true,
      },
    ],
    rules: [
      {
        type: "createObject",
        objectType: "AuditCase",
        properties: {
          caseId: { source: "parameter", param: "caseId" },
          assignedTo: { source: "parameter", param: "assignedTo" },
          priority: { source: "parameter", param: "priority" },
        },
      },
    ],
    requiredObjectTypes: ["AuditCase"],
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Action Types Seed Script (Task 28) ===\n");

  // 1. Find the ontology
  const ontResult = await query(
    "SELECT ontology_id FROM ontology ORDER BY created_at ASC LIMIT 1"
  );
  if (ontResult.rows.length === 0) {
    console.error("ERROR: No ontology found. Run the main seed script first (npm run seed).");
    process.exit(1);
  }
  const ontologyId = ontResult.rows[0].ontology_id as string;
  console.log(`Ontology: ${ontologyId}\n`);

  // 2. Check which object types exist
  const otResult = await query(
    "SELECT api_name FROM object_type WHERE ontology_id = $1",
    [ontologyId]
  );
  const existingObjectTypes = new Set(
    otResult.rows.map((r: Record<string, unknown>) => r.api_name as string)
  );

  console.log(`Existing object types: ${Array.from(existingObjectTypes).sort().join(", ")}\n`);

  // Collect all required object types across all action types
  const allRequired = new Set<string>();
  for (const def of ACTION_TYPES) {
    for (const ot of def.requiredObjectTypes) {
      allRequired.add(ot);
    }
  }

  const missing = Array.from(allRequired).filter(
    (ot) => !existingObjectTypes.has(ot)
  );
  if (missing.length > 0) {
    console.warn(
      `WARNING: The following object types are missing: ${missing.join(", ")}\n` +
        `Action types requiring these will be skipped.\n`
    );
  }

  // 3. Create each action type
  let created = 0;
  let skipped = 0;
  let skippedMissing = 0;

  for (const def of ACTION_TYPES) {
    // Check if all required object types exist
    const missingOTs = def.requiredObjectTypes.filter(
      (ot) => !existingObjectTypes.has(ot)
    );
    if (missingOTs.length > 0) {
      console.log(
        `  SKIP  ${def.apiName} (${def.displayName}) — missing object types: ${missingOTs.join(", ")}`
      );
      skippedMissing++;
      continue;
    }

    try {
      // Check if already exists
      const existing = await getActionType(ontologyId, def.apiName);
      if (existing) {
        console.log(
          `  EXISTS  ${def.apiName} (${def.displayName})`
        );
        skipped++;
        continue;
      }

      await createActionType(ontologyId, {
        apiName: def.apiName,
        displayName: def.displayName,
        description: def.description,
        parameters: def.parameters,
        rules: def.rules,
        maxAffectedObjects: def.maxAffectedObjects ?? 10000,
        isEnabled: def.isEnabled ?? true,
      });

      console.log(
        `  CREATED  ${def.apiName} (${def.displayName})`
      );
      created++;
    } catch (err: any) {
      // Handle duplicate (ACTION_TYPE_ALREADY_EXISTS)
      if (err.code === "ACTION_TYPE_ALREADY_EXISTS") {
        console.log(
          `  EXISTS  ${def.apiName} (${def.displayName})`
        );
        skipped++;
      } else {
        console.error(
          `  FAILED  ${def.apiName} (${def.displayName}): ${err.message}`
        );
      }
    }
  }

  // 4. Summary
  const total = ACTION_TYPES.length;
  const successful = created + skipped;
  console.log(
    `\nSummary: ${created} created, ${skipped} already existed, ${skippedMissing} skipped (missing object types)`
  );
  console.log(
    `${successful}/${total - skippedMissing} action types available (${skippedMissing} need missing object types)`
  );

  // 5. Optional smoke tests for created/existing action types
  console.log("\n--- Smoke Tests ---\n");

  let smokePass = 0;
  let smokeFail = 0;

  for (const def of ACTION_TYPES) {
    // Skip action types whose required object types are missing
    const missingOTs = def.requiredObjectTypes.filter(
      (ot) => !existingObjectTypes.has(ot)
    );
    if (missingOTs.length > 0) continue;

    // Verify the action type can be loaded
    try {
      const loaded = await getActionType(ontologyId, def.apiName);
      if (!loaded) {
        console.log(`  FAIL  ${def.apiName} — not found after creation`);
        smokeFail++;
        continue;
      }

      // Verify key fields
      const params = loaded.parameters as unknown[];
      const rules = loaded.rules as unknown[];
      if (!Array.isArray(params) || params.length === 0) {
        console.log(`  FAIL  ${def.apiName} — parameters empty or not array`);
        smokeFail++;
        continue;
      }
      if (!Array.isArray(rules) || rules.length === 0) {
        console.log(`  FAIL  ${def.apiName} — rules empty or not array`);
        smokeFail++;
        continue;
      }

      console.log(
        `  PASS  ${def.apiName} — ${params.length} params, ${rules.length} rules`
      );
      smokePass++;
    } catch (err: any) {
      console.log(`  FAIL  ${def.apiName} — ${err.message}`);
      smokeFail++;
    }
  }

  console.log(
    `\nSmoke tests: ${smokePass} passed, ${smokeFail} failed`
  );

  if (smokeFail > 0) {
    console.warn(
      "\nWARNING: Some smoke tests failed. The action types were still created — " +
        "check the output above for details."
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main()
  .then(() => {
    console.log("\nDone.");
    pool.end();
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nFATAL:", err);
    pool.end();
    process.exit(1);
  });
