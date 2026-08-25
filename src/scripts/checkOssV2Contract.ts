import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface Inventory {
  sdk: {
    version: string;
    componentsUrl: string;
    objectSetClientUrl: string;
    actionClientUrl: string;
  };
  objectSetNodeTypes: string[];
  searchJsonQueryV2Types: string[];
  loadObjectSet: {
    queryFields: string[];
    bodyFields: string[];
  };
  objectSets: {
    paths: string[];
  };
  actions: {
    modes: string[];
    returnEdits: string[];
    batchReturnEdits: string[];
    batchMaximum: number;
  };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Contract source ${url} returned HTTP ${response.status}`);
  }
  return response.text();
}

function requireNeedles(source: string, needles: string[], label: string): void {
  const missing = needles.filter((needle) => !source.includes(needle));
  if (missing.length > 0) {
    throw new Error(
      `${label} drifted; missing: ${missing.join(", ")}`,
    );
  }
}

function requireFields(source: string, fields: string[], label: string): void {
  const missing = fields.filter(
    (field) =>
      !new RegExp(`\\b${field}\\??:`).test(source),
  );
  if (missing.length > 0) {
    throw new Error(`${label} drifted; missing: ${missing.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const path = resolve("docs/oss-v2-contract-inventory.json");
  const inventory = JSON.parse(await readFile(path, "utf8")) as Inventory;
  const [components, client, actionClient] = await Promise.all([
    fetchText(inventory.sdk.componentsUrl),
    fetchText(inventory.sdk.objectSetClientUrl),
    fetchText(inventory.sdk.actionClientUrl),
  ]);

  requireNeedles(
    components,
    inventory.objectSetNodeTypes.map((type) => `type: "${type}"`),
    "ObjectSet union",
  );
  requireNeedles(
    components,
    inventory.searchJsonQueryV2Types.map((type) => `type: "${type}"`),
    "SearchJsonQueryV2 union",
  );
  requireFields(
    components,
    inventory.loadObjectSet.bodyFields,
    "LoadObjectSetRequestV2",
  );
  requireNeedles(
    client,
    [
      ...inventory.objectSets.paths,
      ...inventory.loadObjectSet.queryFields,
    ],
    "OntologyObjectSet client",
  );
  requireNeedles(
    components,
    [
      ...inventory.actions.modes.map((mode) => `"${mode}"`),
      ...inventory.actions.returnEdits.map((mode) => `"${mode}"`),
      ...inventory.actions.batchReturnEdits.map((mode) => `"${mode}"`),
      "export interface ObjectSetStreamSubscribeRequests",
      "export interface ObjectSetUpdates",
    ],
    "Action and streaming contracts",
  );
  requireNeedles(
    actionClient,
    [
      "/v2/ontologies/{ontology}/actions/{action}/apply",
      "/v2/ontologies/{ontology}/actions/{action}/applyBatch",
      `Up to ${inventory.actions.batchMaximum} actions`,
    ],
    "Action client",
  );
  process.stdout.write(
    JSON.stringify({
      event: "oss_v2_contract.check_passed",
      sdkVersion: inventory.sdk.version,
      objectSetNodeTypes: inventory.objectSetNodeTypes.length,
      searchJsonQueryV2Types: inventory.searchJsonQueryV2Types.length,
      bodyFields: inventory.loadObjectSet.bodyFields.length,
      queryFields: inventory.loadObjectSet.queryFields.length,
      actionModes: inventory.actions.modes.length,
      actionReturnEdits: inventory.actions.returnEdits.length,
      batchMaximum: inventory.actions.batchMaximum,
    }) + "\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      event: "oss_v2_contract.check_failed",
      error: error instanceof Error ? error.message : String(error),
    }) + "\n",
  );
  process.exitCode = 1;
});
