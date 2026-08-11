/**
 * Ingest a generated functional-tier fixture set through Tellus's supported
 * CSV upload -> backing datasource -> reindex path.  It deliberately never
 * writes object rows or index documents directly.
 *
 * This is a QA scaffolding helper, not an end-user action substitute.  The
 * Playwright scenarios use it only before/after a browser-driven journey.
 *
 * Usage:
 *   npx tsx tools/synthetic-data/ingest.ts --out /tmp/tellus-rwanda-qa
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { quarantineDirtyCsv, sanitizeIso8583Csv } from "../../src/qa/rwanda/ingestionSecurity";

const EDITOR = "633a9660-e374-41c6-87e0-d213cf50623d";
const ADMIN = "bdaba072-16f3-41c2-91f8-b367065ec578";
const DEFAULT_BASE = "http://127.0.0.1:3000";

type Uploaded = { apiName: string; datasetId: string };
type Scenario = "a-bk" | "b-irembo" | "c-rswitch" | "d-pindo";

function parseScenarios(value?: string): Set<Scenario> | undefined {
  if (!value) return undefined;
  const scenarios = new Set(value.split(",").map((item) => item.trim()).filter(Boolean) as Scenario[]);
  for (const scenario of scenarios) {
    if (!(["a-bk", "b-irembo", "c-rswitch", "d-pindo"] as string[]).includes(scenario)) {
      throw new Error(`Unknown Rwanda QA scenario '${scenario}'.`);
    }
  }
  return scenarios;
}

function args() {
  const values = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const index = values.indexOf(name);
    return index === -1 ? fallback : values[index + 1] ?? fallback;
  };
  const out = get("--out");
  if (!out) throw new Error("--out <generated fixture directory> is required");
  return {
    out: path.resolve(out),
    base: get("--base", process.env.TELLUS_QA_BASE ?? DEFAULT_BASE)!,
    scenarios: parseScenarios(get("--scenarios", process.env.TELLUS_QA_SCENARIOS)),
    cleanup: values.includes("--cleanup"),
    receipt: path.resolve(get("--receipt", path.join(out, "ingestion-receipt.json"))!),
  };
}

async function api(base: string, pathname: string, init: RequestInit = {}, user = EDITOR) {
  const headers = new Headers(init.headers);
  headers.set("X-Tellus-Test-Auth", user);
  const response = await fetch(`${base}${pathname}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${pathname} -> ${response.status}: ${text.slice(0, 500)}`);
  return body as Record<string, any>;
}

async function csvs(root: string, scenarios?: Set<Scenario>): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".csv"))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !/\/expected_outputs\.csv$|\/dirty_|\/ingestion-inputs\//.test(file))
    .filter((file) => !scenarios || scenarios.has(path.basename(path.dirname(file)) as Scenario));
}

function apiName(file: string) {
  const scenario = path.basename(path.dirname(file)).replace(/^[a-d]-/, "");
  const noun = path.basename(file, ".csv").replace(/_([a-z])/g, (_, char) => char.toUpperCase());
  return `QaRw${scenario[0].toUpperCase()}${scenario.slice(1)}${noun[0].toUpperCase()}${noun.slice(1)}`;
}

function columns(csv: string) {
  const firstLine = csv.slice(0, csv.indexOf("\n")).replace(/^\uFEFF/, "").replace(/\r$/, "");
  const fields = firstLine.split(",").map((field) => field.trim()).filter(Boolean);
  if (!fields.length) throw new Error("CSV has no header row");
  return fields;
}

async function ontologyId(base: string) {
  const result = await api(base, "/api/v1/ontology/default");
  const id = result.ontologyId ?? result.data?.ontologyId;
  if (typeof id !== "string") throw new Error("Default ontology response did not contain ontologyId");
  return id;
}

async function uploadBytes(base: string, bytes: Uint8Array, filename: string, name: string) {
  const form = new FormData();
  form.append("name", name);
  form.append("description", `Synthetic Rwanda QA fixture: ${filename}`);
  form.append("transactionType", "SNAPSHOT");
  form.append("file", new Blob([bytes], { type: "text/csv" }), filename);
  const result = await api(base, "/api/v1/datasets/upload", { method: "POST", body: form });
  const id = result.data?.dataset?.datasetId ?? result.data?.dataset_id ?? result.dataset?.datasetId ?? result.dataset_id;
  if (typeof id !== "string") throw new Error(`Upload did not return a dataset ID for ${filename}: ${JSON.stringify(result).slice(0, 500)}`);
  return id;
}

async function ingestCsv(base: string, ontology: string, uploaded: Uploaded[], type: string, csv: string, filename: string) {
  const header = columns(csv);
  await ensureObjectType(base, ontology, type, header);
  const datasetId = await uploadBytes(base, Buffer.from(csv), filename, `qa-rw-${path.basename(filename, ".csv")}`);
  await api(base, `/api/v1/ontology/${ontology}/objectTypes/${type}/datasource`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datasetId, primaryKeyColumn: header[0], columnMapping: Object.fromEntries(header.map((column) => [column, column])) }),
  });
  uploaded.push({ apiName: type, datasetId });
  await api(base, `/api/v1/ontology/${ontology}/objectTypes/${type}/reindex?force=true`, { method: "POST" }, ADMIN);
}

async function ensureObjectType(base: string, ontology: string, type: string, headers: string[]) {
  const result = await fetch(`${base}/api/v1/ontology/${ontology}/objectTypes/${type}`, {
    headers: { "X-Tellus-Test-Auth": EDITOR },
  });
  if (result.ok) {
    // Do not infer properties from the object-type detail response. That
    // response includes datasource/mapping metadata, which can mention a
    // column that has not actually been persisted as an ontology property.
    // The runner uses a clean, reusable QA database, so schema existence must
    // be checked against the authoritative property collection endpoint.
    const properties = await api(base, `/api/v1/ontology/${ontology}/objectTypes/${type}/properties`);
    const rows = Array.isArray(properties.data) ? properties.data : [];
    const existing = new Set(rows.map((property: Record<string, unknown>) =>
      String(property.apiName ?? property.api_name ?? "")));
    const missing = headers.filter((header) => !existing.has(header));
    if (missing.length > 0) {
      await api(base, `/api/v1/ontology/${ontology}/objectTypes/${type}/properties/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: missing.map((apiName) => ({ apiName, displayName: apiName, baseType: "string" })),
        }),
      });
    }
    return missing.length > 0;
  }
  if (result.status !== 404) throw new Error(`GET object type ${type} -> ${result.status}: ${(await result.text()).slice(0, 500)}`);
  await api(base, `/api/v1/ontology/${ontology}/objectTypes/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiName: type,
      displayName: type.replace(/^QaRw/, "QA Rwanda "),
      status: "experimental",
      primaryKeyProperty: headers[0],
      titleProperty: headers[0],
      properties: headers.map((apiName) => ({ apiName, displayName: apiName, baseType: "string" })),
    }),
  });
  return true;
}

export async function ingestFunctionalFixtures(options = args()): Promise<Uploaded[]> {
  const manifest = JSON.parse(await readFile(path.join(options.out, "manifest.json"), "utf8")) as { tier?: string };
  if (manifest.tier !== "functional") throw new Error("Only functional-tier data may be ingested by this QA helper");
  const ontology = await ontologyId(options.base);
  const files = await csvs(options.out, options.scenarios);
  const uploaded: Uploaded[] = [];
  try {
    for (const file of files) {
      const type = apiName(file);
      const csv = await readFile(file, "utf8");
      await ingestCsv(options.base, ontology, uploaded, type, csv, path.basename(file));
    }
    // Raw ISO-8583 is intentionally transformed before it reaches the
    // supported upload/datasource/reindex pipeline.  No datasource schema or
    // diagnostic contains field2Pan.
    if (!options.scenarios || options.scenarios.has("c-rswitch")) {
      const rawIso = await readFile(path.join(options.out, "c-rswitch/ingestion-inputs/raw_iso8583.csv"), "utf8");
      await ingestCsv(options.base, ontology, uploaded, "QaRwRswitchSanitizedIso8583", sanitizeIso8583Csv(rawIso), "sanitized_iso8583.csv");
    }

    // Rejected source rows are materialized as an indexed, audit-visible
    // dataset.  Diagnostics deliberately carry reasons and row numbers only.
    const entries = await readdir(options.out, { recursive: true, withFileTypes: true });
    const quarantined = (await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith("dirty_") &&
      (!options.scenarios || options.scenarios.has(path.basename(entry.parentPath) as Scenario))).map(async (entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return quarantineDirtyCsv(entry.name, await readFile(file, "utf8"));
    }))).flat();
    const report = ["quarantineId,sourceFile,rowNumber,reasonCode,reason", ...quarantined.map((record, index) =>
      `QA-RW-Q-${String(index + 1).padStart(6, "0")},${record.sourceFile},${record.rowNumber},${record.reasonCode},${record.reason}`)].join("\n") + "\n";
    await ingestCsv(options.base, ontology, uploaded, "QaRwIngestionQuarantine", report, "ingestion_quarantine.csv");
    await writeFile(options.receipt, JSON.stringify({
      version: 1, namespace: "QA-RW", ontology, uploaded,
    }, null, 2));
    console.log(JSON.stringify({ ingested: uploaded.length, namespace: "QA-RW", objectTypes: uploaded.map(({ apiName }) => apiName) }));
    return uploaded;
  } catch (error) {
    await cleanupFunctionalFixtures(options.base, ontology, uploaded);
    throw error;
  }
}

export async function cleanupFunctionalFixtures(base: string, ontology: string, uploaded: Uploaded[]) {
  for (const entry of [...uploaded].reverse()) {
    await fetch(`${base}/api/v1/ontology/${ontology}/objectTypes/${entry.apiName}/datasource`, { method: "DELETE", headers: { "X-Tellus-Test-Auth": ADMIN } }).catch(() => undefined);
    await fetch(`${base}/api/v1/ontology/${ontology}/objectTypes/${entry.apiName}`, { method: "DELETE", headers: { "X-Tellus-Test-Auth": ADMIN } }).catch(() => undefined);
    await fetch(`${base}/api/v1/datasets/${entry.datasetId}?force=true`, { method: "DELETE", headers: { "X-Tellus-Test-Auth": ADMIN } }).catch(() => undefined);
  }
  for (const entry of uploaded) {
    const check = await fetch(`${base}/api/v1/ontology/${ontology}/objectTypes/${entry.apiName}`, {
      headers: { "X-Tellus-Test-Auth": ADMIN },
    });
    if (check.status !== 404) throw new Error(`Cleanup verification failed: ${entry.apiName} still resolves with ${check.status}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = args();
  (options.cleanup
    ? readFile(options.receipt, "utf8").then(async (source) => {
      const receipt = JSON.parse(source) as { ontology: string; uploaded: Uploaded[]; namespace?: string };
      if (!receipt.ontology || !Array.isArray(receipt.uploaded)) throw new Error("Invalid Rwanda ingestion cleanup receipt");
      await cleanupFunctionalFixtures(options.base, receipt.ontology, receipt.uploaded);
      console.log(JSON.stringify({ cleanupVerified: true, namespace: "QA-RW" }));
    })
    : ingestFunctionalFixtures(options))
    .catch((error) => { console.error(error); process.exitCode = 1; });
}
