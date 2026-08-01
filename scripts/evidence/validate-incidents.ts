// ---------------------------------------------------------------------------
// Incident-record validator (audit #5/#6/#9).
//
// Validates the two machine-readable incident artifacts against a small
// declarative schema (required fields, ISO-8601 timestamps, UUID shapes) and
// cross-checks that every referenced evidence file exists on disk.
//
// Validated artifacts (relative to the evidence root, default
// .migration-evidence/):
//   incidents/FUNN-ISO-2026-07-31-split-brain.json
//   funnel-temporal-isolation/2026-07-31T17-23-33-160Z.mapping.json
//
// CLI:  tsx scripts/evidence/validate-incidents.ts [evidenceRoot]   (exit 1 on violation)
// Lib:  validateIncidents(evidenceRoot) -> string[] (violation messages; empty = pass)
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INCIDENT_FILE = "incidents/FUNN-ISO-2026-07-31-split-brain.json";
export const MAPPING_FILE = "funnel-temporal-isolation/2026-07-31T17-23-33-160Z.mapping.json";

// --- small declarative schema helpers -------------------------------------

type Spec =
  | { kind: "string" }
  | { kind: "uuid" }
  | { kind: "iso" }
  | { kind: "null" }
  | { kind: "stringOrNull" }
  | { kind: "uuidOrNull" }
  | { kind: "number" }
  | { kind: "stringArray" }
  | { kind: "object" }
  | { kind: "enum"; values: string[] };

function check(value: unknown, spec: Spec): boolean {
  switch (spec.kind) {
    case "string":
      return typeof value === "string" && value.length > 0;
    case "uuid":
      return typeof value === "string" && UUID_RE.test(value);
    case "iso":
      return typeof value === "string" && ISO_RE.test(value);
    case "null":
      return value === null;
    case "stringOrNull":
      return value === null || (typeof value === "string" && value.length > 0);
    case "uuidOrNull":
      return value === null || (typeof value === "string" && UUID_RE.test(value));
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "stringArray":
      return Array.isArray(value) && value.every((v) => typeof v === "string" && v.length > 0);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
  }
}

function requireFields(
  obj: Record<string, unknown>,
  fields: Record<string, Spec>,
  where: string,
  errors: string[],
): void {
  for (const [field, spec] of Object.entries(fields)) {
    if (!(field in obj)) {
      errors.push(`${where}: missing required field "${field}"`);
    } else if (!check(obj[field], spec)) {
      errors.push(
        `${where}: field "${field}" failed shape check (${spec.kind}) — got ${JSON.stringify(obj[field])}`,
      );
    }
  }
}

function checkFilesExist(
  files: unknown,
  evidenceRoot: string,
  where: string,
  errors: string[],
): void {
  if (!Array.isArray(files)) {
    errors.push(`${where}: expected an array of evidence file paths`);
    return;
  }
  for (const f of files) {
    if (typeof f !== "string" || f.length === 0) {
      errors.push(`${where}: evidence file entry must be a non-empty string`);
      continue;
    }
    if (path.isAbsolute(f) || f.includes("..")) {
      errors.push(`${where}: evidence file "${f}" must be relative to the evidence root`);
      continue;
    }
    if (!fs.existsSync(path.join(evidenceRoot, f))) {
      errors.push(`${where}: referenced evidence file does not exist: ${f}`);
    }
  }
}

function checkEvidenceRef(
  ref: unknown,
  evidenceRoot: string,
  where: string,
  errors: string[],
): void {
  if (typeof ref !== "string" || ref.length === 0) return; // nullable refs handled by caller
  // "see <file>" prose references: extract the path portion when prefixed.
  const candidate = ref.startsWith("see ") ? ref.slice(4).trim() : ref;
  if (/^[\w./-]+$/.test(candidate) && candidate.includes("/")) {
    if (!fs.existsSync(path.join(evidenceRoot, candidate))) {
      errors.push(`${where}: referenced evidence file does not exist: ${candidate}`);
    }
  }
}

// --- incident record --------------------------------------------------------

function validateIncident(doc: Record<string, unknown>, evidenceRoot: string, errors: string[]): void {
  requireFields(
    doc,
    {
      schemaVersion: { kind: "number" },
      incidentId: { kind: "string" },
      title: { kind: "string" },
      detectedAtUtc: { kind: "iso" },
      resolvedAtUtc: { kind: "iso" },
      phantomRun: { kind: "object" },
      remediation: { kind: "object" },
      snapshot: { kind: "object" },
      explanation: { kind: "string" },
    },
    "incident",
    errors,
  );

  if (doc.schemaVersion !== 1) errors.push(`incident: schemaVersion must be 1`);
  if (doc.incidentId !== "FUNN-ISO-2026-07-31-SPLIT-BRAIN") {
    errors.push(`incident: incidentId must be "FUNN-ISO-2026-07-31-SPLIT-BRAIN"`);
  }

  const phantom = doc.phantomRun as Record<string, unknown> | undefined;
  if (phantom && typeof phantom === "object") {
    requireFields(
      phantom,
      {
        runId: { kind: "uuid" },
        database: { kind: "string" },
        status: { kind: "enum", values: ["running"] },
        currentStage: { kind: "enum", values: ["merge"] },
        environmentId: { kind: "null" },
        workflowId: { kind: "string" },
        lastCompletedStage: { kind: "enum", values: ["changelog"] },
        pendingStage: { kind: "enum", values: ["merge"] },
      },
      "incident.phantomRun",
      errors,
    );
    if (
      typeof phantom.workflowId === "string" &&
      !phantom.workflowId.startsWith("ObjectTypeFunnelWorkflow-OlivierOrder:")
    ) {
      errors.push(`incident.phantomRun: workflowId must reference the OlivierOrder legacy workflow`);
    }
  }

  const remediation = doc.remediation as Record<string, unknown> | undefined;
  if (remediation && typeof remediation === "object") {
    requireFields(
      remediation,
      {
        action: { kind: "enum", values: ["namespace_retirement_and_database_snapshot_then_retirement"] },
        reason: { kind: "string" },
        incidentId: { kind: "string" },
        environmentId: { kind: "enum", values: ["tellus-dev"] },
        completedAtUtc: { kind: "iso" },
        terminatedWorkflows: { kind: "stringArray" },
        replacementNamespace: { kind: "enum", values: ["tellus-funnel-tellus-dev"] },
        evidenceFiles: { kind: "stringArray" },
      },
      "incident.remediation",
      errors,
    );
    if (remediation.incidentId !== doc.incidentId) {
      errors.push(`incident.remediation: incidentId must match the top-level incidentId`);
    }
    const expectedTerminated = [
      "ObjectTypeFunnelWorkflow-OlivierOrder",
      "ObjectTypeFunnelWorkflow-OlivierOrderJune",
      "ObjectTypeFunnelWorkflow-OlivierOrder11",
      "ObjectTypeFunnelWorkflow-RealEstateProperty",
    ];
    const terminated = (remediation.terminatedWorkflows as string[]) ?? [];
    for (const wf of expectedTerminated) {
      if (!terminated.includes(wf)) {
        errors.push(`incident.remediation: terminatedWorkflows is missing "${wf}"`);
      }
    }
    checkFilesExist(remediation.evidenceFiles, evidenceRoot, "incident.remediation", errors);
  }

  const snapshot = doc.snapshot as Record<string, unknown> | undefined;
  if (snapshot && typeof snapshot === "object") {
    requireFields(
      snapshot,
      {
        database: { kind: "enum", values: ["tellus_automate_verify"] },
        capturedAtUtc: { kind: "iso" },
        preservedFiles: { kind: "stringArray" },
      },
      "incident.snapshot",
      errors,
    );
    const preserved = (snapshot.preservedFiles as string[]) ?? [];
    if (remediation && Array.isArray(remediation.evidenceFiles)) {
      for (const f of preserved) {
        if (!(remediation.evidenceFiles as string[]).includes(f)) {
          errors.push(`incident.snapshot: preserved file "${f}" is not listed in remediation.evidenceFiles`);
        }
      }
    }
    checkFilesExist(preserved, evidenceRoot, "incident.snapshot", errors);
  }
}

// --- migration completeness mapping ------------------------------------------

function validateMapping(doc: Record<string, unknown>, evidenceRoot: string, errors: string[]): void {
  requireFields(
    doc,
    {
      schemaVersion: { kind: "number" },
      kind: { kind: "enum", values: ["legacy-workflow-migration-mapping"] },
      capturedAtUtc: { kind: "iso" },
      captureFile: { kind: "string" },
      oldNamespace: { kind: "enum", values: ["tellus-funnel"] },
      replacementNamespace: { kind: "enum", values: ["tellus-funnel-tellus-dev"] },
    },
    "mapping",
    errors,
  );
  if (!Array.isArray(doc.entries)) {
    errors.push(`mapping: entries must be an array`);
    return;
  }
  checkFilesExist([doc.captureFile], evidenceRoot, "mapping", errors);

  const entries = doc.entries as Array<Record<string, unknown>>;
  const funnelEntries = entries.filter((e) => e.kind === "funnel");
  const maintenanceEntries = entries.filter((e) => e.kind === "pipeline-maintenance");
  if (funnelEntries.length !== 4) {
    errors.push(`mapping: expected exactly 4 funnel entries, got ${funnelEntries.length}`);
  }
  if (maintenanceEntries.length < 6) {
    errors.push(`mapping: expected at least 6 pipeline-maintenance entries, got ${maintenanceEntries.length}`);
  }
  for (const e of entries) {
    if (e.kind !== "funnel" && e.kind !== "pipeline-maintenance") {
      errors.push(`mapping.entries[${e.oldWorkflowId}]: unknown kind ${JSON.stringify(e.kind)}`);
    }
  }

  for (const e of funnelEntries) {
    const where = `mapping.entry[${e.oldWorkflowId}]`;
    requireFields(
      e,
      {
        oldNamespace: { kind: "enum", values: ["tellus-funnel"] },
        oldWorkflowId: { kind: "string" },
        oldRunId: { kind: "null" },
        lastCompletedStage: { kind: "stringOrNull" },
        replacementNamespace: { kind: "enum", values: ["tellus-funnel-tellus-dev"] },
        replacementWorkflowId: { kind: "stringOrNull" },
        terminalStatus: { kind: "enum", values: ["indexed", "terminated", "failed"] },
      },
      where,
      errors,
    );
    checkEvidenceRef(e.pendingSignals, evidenceRoot, where, errors);
    const objectType = String(e.oldWorkflowId).replace(/^ObjectTypeFunnelWorkflow-/, "");
    if (e.replacementWorkflowId !== null) {
      const expected = `ObjectTypeFunnelWorkflow/00000000-0000-0000-0000-000000000001/`;
      if (!String(e.replacementWorkflowId).startsWith(expected)) {
        errors.push(`${where}: replacementWorkflowId must use the ObjectTypeFunnelWorkflow/<ontologyRid>/<objectTypeRid> form`);
      }
      if (e.stateReconstructedFrom === null) {
        errors.push(`${where}: stateReconstructedFrom must reference evidence when a replacement workflow exists`);
      }
    }
    checkEvidenceRef(e.stateReconstructedFrom, evidenceRoot, where, errors);
    const run = e.resultingFunnelRun as Record<string, unknown> | null | undefined;
    if (run !== null && run !== undefined) {
      requireFields(run, { runId: { kind: "uuid" }, evidenceFile: { kind: "string" } }, `${where}.resultingFunnelRun`, errors);
      checkFilesExist([run.evidenceFile], evidenceRoot, `${where}.resultingFunnelRun`, errors);
    } else if (e.terminalStatus === "indexed") {
      errors.push(`${where}: terminalStatus "indexed" requires a resultingFunnelRun`);
    }
    if (e.terminalStatus === "terminated" && e.replacementWorkflowId !== null) {
      errors.push(`${where}: terminated entries must not carry a replacementWorkflowId`);
    }
    if (objectType === "OlivierOrder" && e.terminalStatus !== "indexed") {
      errors.push(`${where}: OlivierOrder must have been reconstructed to a terminal "indexed" state`);
    }
  }

  for (const e of maintenanceEntries) {
    const where = `mapping.entry[${e.oldWorkflowId}]`;
    requireFields(
      e,
      {
        oldNamespace: { kind: "enum", values: ["tellus-funnel"] },
        oldWorkflowId: { kind: "string" },
        oldRunId: { kind: "uuidOrNull" },
        classification: { kind: "string" },
      },
      where,
      errors,
    );
    if (typeof e.oldWorkflowId === "string" && !e.oldWorkflowId.startsWith("pb-b4-iceberg-maintenance-workflow-")) {
      errors.push(`${where}: pipeline-maintenance entries must be pb-b4-iceberg-maintenance-workflow executions`);
    }
    if (typeof e.classification === "string" && !e.classification.startsWith("external-scheduler-regenerated")) {
      errors.push(`${where}: classification must start with "external-scheduler-regenerated"`);
    }
  }

  // Completeness: every terminated funnel workflow in the capture file is mapped.
  const capturePath = path.join(evidenceRoot, String(doc.captureFile));
  if (fs.existsSync(capturePath)) {
    const capture = JSON.parse(fs.readFileSync(capturePath, "utf8")) as { terminated?: string[] };
    for (const wf of capture.terminated ?? []) {
      if (!funnelEntries.some((e) => e.oldWorkflowId === wf)) {
        errors.push(`mapping: terminated workflow "${wf}" from the capture file has no mapping entry`);
      }
    }
  }
}

// --- entry point -------------------------------------------------------------

export function validateIncidents(evidenceRoot: string): string[] {
  const errors: string[] = [];

  const incidentPath = path.join(evidenceRoot, INCIDENT_FILE);
  if (!fs.existsSync(incidentPath)) {
    errors.push(`incident record missing: ${INCIDENT_FILE}`);
  } else {
    try {
      validateIncident(JSON.parse(fs.readFileSync(incidentPath, "utf8")), evidenceRoot, errors);
    } catch (err) {
      errors.push(`incident record is not valid JSON: ${(err as Error).message}`);
    }
  }

  const mappingPath = path.join(evidenceRoot, MAPPING_FILE);
  if (!fs.existsSync(mappingPath)) {
    errors.push(`migration mapping missing: ${MAPPING_FILE}`);
  } else {
    try {
      validateMapping(JSON.parse(fs.readFileSync(mappingPath, "utf8")), evidenceRoot, errors);
    } catch (err) {
      errors.push(`migration mapping is not valid JSON: ${(err as Error).message}`);
    }
  }

  return errors;
}

if (require.main === module) {
  const evidenceRoot = process.argv[2] ?? ".migration-evidence";
  const errors = validateIncidents(evidenceRoot);
  if (errors.length === 0) {
    console.log(`validate-incidents: OK — incident record and migration mapping valid under ${evidenceRoot}`);
  } else {
    console.error(`validate-incidents: ${errors.length} violation(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}
