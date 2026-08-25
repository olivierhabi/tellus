// scripts/automate-verify-stack/seed-domain.ts
// ------------------------------------------------------------
// Deterministic isolated-stack domain seeding for the Tellus Automate
// verification suite. Creates everything the four isolated browser E2E
// scenarios + the Function-version semantics tests require, through REAL
// production API paths only:
//
//   • ontology (already migrated) → object type + properties (API batch)
//   • action types that create / modify the seed object type (API)
//   • a real Stemma code-repository (POST /code-repositories)
//   • real git commits of TypeScript Function sources (POST …/commits)
//   • real publication via POST /:rid/tags → jemma publish worker → poll
//   • reads the published registry (GET /functions/registry/…/versions)
//
// Idempotent: deterministic Idempotency-Keys + check-before-create so an
// interrupted run recovers safely. Isolated from the shared dev DB by env
// (PGDATABASE, KEYCLOAK_REALM, S3_BUCKET set by up.sh). Fail-loud: each
// step reports its name + the exact failure. Auto-invoked by up.sh.
// ------------------------------------------------------------

// Env is sourced by the invoking shell (up.sh sources .env + stack.env).
const API_BASE: string = (() => {
  const port = process.env.VERIFY_API_PORT ?? "3100";
  return `http://localhost:${port}/api/v1`;
})();
const KC_URL = process.env.KEYCLOAK_URL ?? "http://localhost:8086";
const KC_REALM = process.env.VERIFY_REALM ?? "tellus-automate-verify";
const KC_CLIENT = process.env.KEYCLOAK_FRONTEND_CLIENT_ID ?? "tellus-frontend";
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? "automate-verify-owner@tellus.local";
const OWNER_PASS = process.env.OWNER_PASS ?? "Password123!";
const ONTOLOGY_ALIAS = "default";
const OUT_FILE = "/tmp/automate-verify-stack/seed.json";
const TYPE_API = "VerifyTaxpayer";
const REPO_DISPLAY = "Automate Verify Functions";
// Deterministic folder rid — any valid compass-folder rid whose UUID the
// saga resolves through executeCreateRepositorySaga; the API does not
// mandate real folder existence (owner-access is granted via repo.creator).
const REPO_PARENT =
  "ri.compass.main.folder.0123abcd-ef01-4345-8789-abcdef000001";
const TEMPLATE = "typescript-functions";
const TEMPLATE_VERSION = "2.4.0";
const FUNCTION_PATH = "typescript-functions/src/functions";

// All functions seeded here are published through the REAL publication
// pipeline and are therefore stamped with the positional
// `typescript-v2-positional-v2` invocation contract (new publishes): every
// configured parameter is resolved BY PUBLISHED NAME and invoked
// POSITIONALLY in published order — no wrapper object, no injected client.
// The binding key must equal the published parameter name.
//   verifyMarker: signature `(input: string)` — compatible across v1↔v2
//   (same signature); v3 renames the parameter (`input`→`marker`), which is
//   a backward-incompatible input-contract change → requires MAJOR 2.0.0.
const VERIFY_MARKER_V1 = `export default function verifyMarker(input: string): string {
  return "fn-v1:" + input;
}
`;
const VERIFY_MARKER_V2 = `export default function verifyMarker(input: string): string {
  return "fn-v2:" + input;
}
`;
const VERIFY_MARKER_V3 = `export default function verifyMarker(marker: string): string {
  return "fn-v3:" + marker;
}
`;
// verifyFail: throws predictably when the bound value is "boom" (scenario 2).
const VERIFY_FAIL_SRC = `export default function verifyFail(input: string): string {
  if (input === "boom") {
    throw new Error("verifyFail: predictable failure for boom");
  }
  return "fail-ok:" + input;
}
`;
// helloWorld: the canonical "standard TypeScript v2" proof — one string
// parameter, invoked positionally: helloWorld("Olivier") === "Hello, Olivier".
const HELLO_WORLD_SRC = `export default function helloWorld(name: string): string {
  return "Hello, " + name;
}
`;
// typedParams: multi-parameter typed proof (string + number + boolean).
const TYPED_PARAMS_SRC = `export default function typedParams(label: string, count: number, enabled: boolean): string {
  return label + "|" + (count + 1) + "|" + (enabled ? "on" : "off");
}
`;

interface SeedOutput {
  ontologyId: string;
  objectTypeApiName: string;
  actionTypes: string[];
  repositoryRid: string;
  branch: string;
  functions: {
    verifyMarker: {
      functionRid: string;
      apiName: string;
      branch: string;
      v1: { semver: string; artifactSha256: string };
      v2: { semver: string; artifactSha256: string };
      v3: { semver: string; artifactSha256: string };
    };
    verifyFail: { functionRid: string; apiName: string; branch: string; v1: { semver: string; artifactSha256: string } };
    helloWorld: { functionRid: string; apiName: string; branch: string; v1: { semver: string; artifactSha256: string } };
    typedParams: { functionRid: string; apiName: string; branch: string; v1: { semver: string; artifactSha256: string } };
  };
  seedOwnerUserId: string;
}

let token = "";
let ownerId = "";

function step<T>(name: string, fn: () => Promise<T>): () => Promise<T | undefined> {
  return async () => {
    process.stdout.write(`seed: ${name} … `);
    try {
      const result = await fn();
      console.log("ok");
      return result;
    } catch (e) {
      console.error("FAILED");
      console.error(`  step: ${name}`);
      console.error(`  error: ${e instanceof Error ? e.message : String(e)}`);
      // surface a short stack for integration triage
      if (e instanceof Error && e.stack) {
        console.error("  " + e.stack.split("\n").slice(0, 4).join("\n  "));
      }
      process.exit(1);
    }
  };
}

function b64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}
function u64(s: string): string {
  return Buffer.from(s, "base64").toString("utf-8");
}
function uuid(): string {
  // stable-ish random v4 — crypto.randomUUID is available in Node.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("crypto").randomUUID();
}
function idemKey(_name: string): string {
  // Idempotency across this single seed run only — re-runs rely on the
  // seed's own check-before-create (object-type lookup, repo display-name
  // match, commit content-diff) so the server-side dedup never has to
  // replay a create here. crypto.randomUUID() produces a valid UUID/ULID.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("crypto").randomUUID();
}

async function http(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; etag?: string }> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, etag: res.headers.get("etag") ?? undefined };
}

async function kcToken(): Promise<string> {
  const res = await fetch(
    `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: KC_CLIENT,
        username: OWNER_EMAIL,
        password: OWNER_PASS,
      }),
    },
  );
  if (!res.ok) {
    const t = await res.text();
    throw new Error(
      `KC password grant failed (${res.status}) for ${OWNER_EMAIL} in realm ${KC_REALM}: ${t}`,
    );
  }
  const claims = JSON.parse(await res.text());
  token = claims.access_token;
  // Decode the JWT userId for annotation in the seed output.
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64").toString("utf-8"),
    );
    ownerId = payload.sub;
  } catch {
    ownerId = "";
  }
  return token;
}

// --- Step 1: ontology ------------------------------------------------------
async function seedOntology(): Promise<string> {
  const r = await http("GET", `/ontology/${ONTOLOGY_ALIAS}`);
  if (r.status !== 200) {
    throw new Error(`ontology resolve ${ONTOLOGY_ALIAS} → ${r.status} ${JSON.stringify(r.body)}`);
  }
  const ontology = (r.body?.data ?? r.body).ontologyId ?? r.body?.data?.ontologyId;
  if (!ontology) throw new Error(`ontology '${ONTOLOGY_ALIAS}' missing ontologyId in ${JSON.stringify(r.body)}`);
  return ontology;
}

// --- Step 2: object type ---------------------------------------------------
async function seedObjectType(ontologyId: string): Promise<void> {
  const check = await http("GET", `/ontology/${ontologyId}/objectTypes/${TYPE_API}`);
  if (check.status === 200) {
    console.log(`(exists) `);
    return;
  }
  if (check.status !== 404) {
    throw new Error(`unexpected object type lookup status ${check.status}: ${JSON.stringify(check.body)}`);
  }
  const body = {
    apiName: TYPE_API,
    displayName: "Automate Verify Taxpayer",
    description: "Seeder-managed object type for Automate isolated verification",
    status: "active",
    icon: "cube",
    iconColor: "#1565C0",
    primaryKeyProperty: "tin",
    titleProperty: "fullName",
    properties: [
      { apiName: "tin", displayName: "TIN", baseType: "string", isRequired: true, ordinal: 0 },
      { apiName: "fullName", displayName: "Full Name", baseType: "string", isRequired: true, ordinal: 1 },
      { apiName: "province", displayName: "Province", baseType: "string", isRequired: false, ordinal: 2 },
      { apiName: "riskScore", displayName: "Risk Score", baseType: "double", isRequired: false, ordinal: 3 },
    ],
  };
  const r = await http(
    "POST",
    `/ontology/${ontologyId}/objectTypes/batch`,
    body,
    { "Idempotency-Key": idemKey("objectType") },
  );
  if (r.status !== 201) {
    throw new Error(`object type batch create → ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  }
}

// --- Step 3: action types --------------------------------------------------
function actionDef(apiName: string, displayName: string, params: any[], rules: any[]) {
  return { apiName, displayName, parameters: params, rules };
}

async function seedActionType(ontologyId: string, def: any): Promise<void> {
  // POST returns 201 (created) or, on repeat, the backend's own duplicate
  // handling. Accept 409 ("already exists") too — idempotent recovery.
  const r = await http(
    "POST",
    `/ontology/${ontologyId}/actionTypes`,
    def,
    { "Idempotency-Key": idemKey(`action:${def.apiName}`) },
  );
  if (r.status !== 201 && r.status !== 409 && r.status !== 200) {
    throw new Error(
      `action type ${def.apiName} create → ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`,
    );
  }
}

// --- Step 4: code repository ----------------------------------------------
async function findRepoByDisplayName(): Promise<string | null> {
  // List repos the owner can see; match by display name. Idempotent: a
  // prior interrupted run created the repo — reuse it rather than create a
  // duplicate (even though Idempotency-Key dedups a retry of the SAME create).
  const r = await http("GET", `/code-repositories?limit=200`);
  if (r.status !== 200) {
    throw new Error(`repo list → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  const items = r.body?.items ?? [];
  const found = items.find((it: any) => it.displayName === REPO_DISPLAY);
  return found ? found.rid : null;
}

async function seedRepo(): Promise<string> {
  const existing = await findRepoByDisplayName();
  if (existing) {
    console.log(`(reuse ${existing}) `);
    return existing;
  }
  const r = await http(
    "POST",
    `/code-repositories`,
    {
      displayName: REPO_DISPLAY,
      parentFolderRid: REPO_PARENT,
      templateId: TEMPLATE,
      templateVersion: TEMPLATE_VERSION,
      defaultBranch: "main",
    },
    { "Idempotency-Key": idemKey("repo") },
  );
  if (r.status !== 201) {
    throw new Error(`repo create → ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  }
  return r.body.rid;
}

// --- Step 5: git commits + tags -------------------------------------------
async function headSha(repoRid: string): Promise<string> {
  const r = await http("GET", `/code-repositories/${repoRid}/branches`);
  const branches = r.body?.branches ?? r.body?.items ?? [];
  const main = Array.isArray(branches)
    ? branches.find((b: any) => b.name === "main" || b.branch === "main") ?? branches[0]
    : branches;
  const sha = main?.headSha ?? main?.head_sha ?? main?.commitSha ?? main?.sha;
  if (!sha) throw new Error(`could not resolve HEAD sha from branches response: ${JSON.stringify(r.body).slice(0, 300)}`);
  return sha;
}

async function readFileContent(repoRid: string, path: string): Promise<string | null> {
  const r = await http(
    "GET",
    `/code-repositories/${repoRid}/branches/main/files?path=${encodeURIComponent(path)}`,
  );
  if (r.status !== 200) return null;
  const entry = r.body?.items?.[0] ?? r.body?.item ?? r.body?.data ?? r.body;
  if (!entry) return null;
  if (typeof entry.content === "string" && entry.encoding !== "base64") return entry.content;
  if (typeof entry.content === "string") return u64(entry.content);
  return null;
}

async function commit(
  repoRid: string,
  message: string,
  changes: { path: string; op: "add" | "modify"; content: string }[],
  headers: Record<string, string> = {},
): Promise<string | null> {
  const parent = await headSha(repoRid);
  // Only commit files whose content differs (idempotent recovery).
  const needed: { path: string; op: "add" | "modify"; contentBase64: string }[] = [];
  for (const c of changes) {
    const cur = await readFileContent(repoRid, c.path);
    if (cur === c.content) {
      process.stdout.write(`(skip-unchanged ${c.path}) `);
      continue;
    }
    needed.push({ path: c.path, op: cur === null ? "add" : "modify", contentBase64: b64(c.content) });
  }
  if (needed.length === 0) return parent;
  const r = await http(
    "POST",
    `/code-repositories/${repoRid}/branches/main/commits`,
    { message, parentSha: parent, fileChanges: needed },
    { "If-Match": `"${parent}"`, "Idempotency-Key": idemKey("commit:" + message), ...headers },
  );
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`commit '${message}' → ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  }
  return await headSha(repoRid);
}

async function versionAlreadyPublished(apiName: string, semver: string): Promise<boolean> {
  // Idempotent publish: a prior (possibly interrupted) run may already have
  // published this exact semver. Resolve the registry (if the function
  // exists yet) and check its published versions. 404 = function not yet
  // created → first run → not published.
  const r = await http("GET", `/functions/registry?q=${encodeURIComponent(apiName)}&limit=100`);
  if (r.status !== 200) return false;
  const items = r.body?.items ?? [];
  const found = items.find((it: any) => it.apiName === apiName);
  if (!found) return false;
  const vr = await http("GET", `/functions/registry/${found.rid}/versions`);
  if (vr.status !== 200) return false;
  const versions = vr.body?.items ?? [];
  return versions.some((v: any) => v.version === semver);
}

async function publishAndPoll(
  repoRid: string,
  semver: string,
  branch = "main",
  apiName = "verifyMarker",
): Promise<{ runRid: string; state: string }> {
  if (await versionAlreadyPublished(apiName, semver)) {
    process.stdout.write(`(already-published ${semver}) `);
    return { runRid: "", state: "SUCCEEDED" };
  }
  const r = await http(
    "POST",
    `/code-repositories/${repoRid}/tags`,
    { semver, branch },
    { "Idempotency-Key": idemKey(`tag:${semver}:${apiName}`) },
  );
  // 202 = new run enqueued; 200 = deduplicated replay of a prior run.
  if (r.status !== 202 && r.status !== 200 && r.status !== 201) {
    throw new Error(`tag ${semver} → ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  }
  const runObj = r.body?.run ?? r.body?.data?.run ?? r.body;
  let runRid = runObj?.runRid ?? runObj?.rid ?? r.body?.runRid ?? r.body?.run?.runRid;
  if (!runRid) {
    // Legacy synchronous path returned the version directly.
    return { runRid: "", state: "SUCCEEDED" };
  }
  // Poll the jemma run until SUCCEEDED/FAILED/CANCELLED.
  const deadline = Date.now() + 5 * 60 * 1000;
  let state: string = r.body?.status ?? runObj?.state ?? "PENDING";
  while (Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 1500));
    const pr = await http("GET", `/jemma/runs/${runRid}`);
    if (pr.status === 404) continue; // run row may lag by a tick
    state = pr.body?.state ?? pr.body?.data?.state ?? state;
    if (state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED") {
      if (state !== "SUCCEEDED") {
        // Dump the failing run's logs to aid triage.
        const logs = await http("GET", `/jemma/runs/${runRid}/logs`);
        throw new Error(
          `publish ${semver} run ${runRid} → ${state}. logs: ${JSON.stringify(logs.body).slice(0, 800)}`,
        );
      }
      return { runRid, state };
    }
  }
  throw new Error(`publish ${semver} run ${runRid} did not finish in 5 minutes (state=${state})`);
}

// --- Step 6: registry resolution ------------------------------------------
async function resolveFunction(ontologyIdIgnored: void, apiName: string): Promise<{ functionRid: string; apiName: string }> {
  // The functionsRegistry router is mounted at /api/v1/functions, so its
  // routes are relative to that base (e.g. /registry?q=, not /functions/registry).
  const r = await http("GET", `/functions/registry?q=${encodeURIComponent(apiName)}&limit=100`);
  if (r.status !== 200) {
    throw new Error(`registry search ${apiName} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  const items = r.body?.items ?? [];
  const found = items.find((it: any) => it.apiName === apiName);
  if (!found) {
    throw new Error(`registry did not list a function with apiName '${apiName}' (got ${items.length} items)`);
  }
  return { functionRid: found.rid, apiName: found.apiName };
}

async function resolveVersion(
  functionRid: string,
  semver: string,
): Promise<{ semver: string; artifactSha256: string; branch: string }> {
  const r = await http("GET", `/functions/registry/${functionRid}/versions`);
  if (r.status !== 200) {
    throw new Error(`versions for ${functionRid} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  const items = r.body?.items ?? [];
  const found = items.find((it: any) => it.version === semver);
  if (!found) {
    throw new Error(
      `no published version ${semver} for ${functionRid} (have ${items.map((i: any) => i.version).join(",")})`,
    );
  }
  if (!found.artifactSha256 || !/^[0-9a-f]{64}$/i.test(found.artifactSha256)) {
    throw new Error(`version ${semver} for ${functionRid} has no artifactSha256: ${JSON.stringify(found).slice(0, 200)}`);
  }
  return { semver: found.version, artifactSha256: found.artifactSha256, branch: found.branch };
}

async function main() {
  console.log(`seed-domain: API=${API_BASE} realm=${KC_REALM} owner=${OWNER_EMAIL}`);
  await step("1/9 KC password grant (owner realm)", kcToken)();
  const ontologyId = await step("2/9 ontology resolve (default)", seedOntology)();
  await step("3/9 object type VerifyTaxpayer (objectTypes/batch)", () =>
    seedObjectType(ontologyId),
  )();
  const actionTypes = [
    actionDef(
      "avtSeedVerifyTaxpayer",
      "Automate Verify: Seed VerifyTaxpayer",
      [
        { apiName: "tin", displayName: "TIN", type: "string", required: true },
        { apiName: "fullName", displayName: "Full Name", type: "string", required: true },
        { apiName: "riskScore", displayName: "Risk Score", type: "double", required: false },
      ],
      [
        {
          type: "createObject",
          objectType: TYPE_API,
          properties: {
            tin: { source: "parameter", param: "tin" },
            fullName: { source: "parameter", param: "fullName" },
            riskScore: { source: "parameter", param: "riskScore" },
          },
        },
      ],
    ),
    actionDef(
      "avtRenameVerifyTaxpayer",
      "Automate Verify: Rename VerifyTaxpayer",
      [
        { apiName: "taxpayerRef", displayName: "TIN reference", type: "string", required: true },
        { apiName: "newFullName", displayName: "New Full Name", type: "string", required: true },
      ],
      [
        {
          type: "modifyObject",
          objectType: TYPE_API,
          objectReference: { source: "parameter", param: "taxpayerRef" },
          properties: { fullName: { source: "parameter", param: "newFullName" } },
        },
      ],
    ),
    actionDef(
      "avtTouchVerifyTaxpayerProvince",
      "Automate Verify: Touch province (unmonitored)",
      [
        { apiName: "taxpayerRef", displayName: "TIN reference", type: "string", required: true },
        { apiName: "newProvince", displayName: "New Province", type: "string", required: true },
      ],
      [
        {
          type: "modifyObject",
          objectType: TYPE_API,
          objectReference: { source: "parameter", param: "taxpayerRef" },
          properties: { province: { source: "parameter", param: "newProvince" } },
        },
      ],
    ),
    actionDef(
      "avtCreateVerifyTaxpayer",
      "Automate Verify: Create Taxpayer (side-effect action)",
      [
        { apiName: "tin", displayName: "TIN", type: "string", required: true },
        { apiName: "fullName", displayName: "Full Name", type: "string", required: true },
        { apiName: "riskScore", displayName: "Risk Score", type: "double", required: false },
      ],
      [
        {
          type: "createObject",
          objectType: TYPE_API,
          properties: {
            tin: { source: "parameter", param: "tin" },
            fullName: { source: "parameter", param: "fullName" },
            riskScore: { source: "parameter", param: "riskScore" },
          },
        },
      ],
    ),
  ];
  await step("4/9 action types (seed/rename/touch/create)", async () => {
    for (const def of actionTypes) {
      await seedActionType(ontologyId, def);
    }
  })();
  const repoRid = await step("5/9 code repository (POST + saga)", seedRepo)();
  // --- Publish v1 at 1.0.0 -------------------------------------------------
  await step("6a/9 commit v1 functions (verifyMarker+verifyFail+helloWorld+typedParams)", async () => {
    await commit(repoRid, "seed v1: verifyMarker + verifyFail + helloWorld + typedParams", [
      { path: `${FUNCTION_PATH}/verifyMarker.ts`, op: "add", content: VERIFY_MARKER_V1 },
      { path: `${FUNCTION_PATH}/verifyFail.ts`, op: "add", content: VERIFY_FAIL_SRC },
      { path: `${FUNCTION_PATH}/helloWorld.ts`, op: "add", content: HELLO_WORLD_SRC },
      { path: `${FUNCTION_PATH}/typedParams.ts`, op: "add", content: TYPED_PARAMS_SRC },
    ]);
  })();
  await step("6b/9 publish v1 1.0.0 (POST /tags → jemma)", () =>
    publishAndPoll(repoRid, "1.0.0"),
  )();
  // --- Publish v2 at 1.1.0 (compatible, same signature) ------------------
  await step("7a/9 commit v2 verifyMarker (compatible)", async () => {
    await commit(repoRid, "seed v2: verifyMarker compatible upgrade", [
      { path: `${FUNCTION_PATH}/verifyMarker.ts`, op: "modify", content: VERIFY_MARKER_V2 },
    ]);
  })();
  await step("7b/9 publish v2 1.1.0 (POST /tags → jemma)", () =>
    publishAndPoll(repoRid, "1.1.0"),
  )();
  // --- Publish v3 at 2.0.0 (incompatible: added required param → MAJOR) ---
  await step("8a/9 commit v3 verifyMarker (incompatible)", async () => {
    await commit(repoRid, "seed v3: verifyMarker incompatible (added required param)", [
      { path: `${FUNCTION_PATH}/verifyMarker.ts`, op: "modify", content: VERIFY_MARKER_V3 },
    ]);
  })();
  await step("8b/9 publish v3 2.0.0 (POST /tags → jemma)", () =>
    publishAndPoll(repoRid, "2.0.0"),
  )();
  // --- Resolve the published registry once all three versions exist -----
  const out: SeedOutput = {
    ontologyId,
    objectTypeApiName: TYPE_API,
    actionTypes: actionTypes.map((a) => a.apiName),
    repositoryRid: repoRid,
    branch: "main",
    functions: {} as any,
    seedOwnerUserId: ownerId,
  };
  await step("9/9 resolve published registry (functionRid + artifactSha256)", async () => {
    const marker = await resolveFunction(undefined as any, "verifyMarker");
    const fail = await resolveFunction(undefined as any, "verifyFail");
    out.functions.verifyMarker = {
      functionRid: marker.functionRid,
      apiName: marker.apiName,
      branch: "main",
      v1: await resolveVersion(marker.functionRid, "1.0.0"),
      v2: await resolveVersion(marker.functionRid, "1.1.0"),
      v3: await resolveVersion(marker.functionRid, "2.0.0"),
    };
    out.functions.verifyFail = {
      functionRid: fail.functionRid,
      apiName: fail.apiName,
      branch: "main",
      v1: await resolveVersion(fail.functionRid, "1.0.0"),
    };
    const hello = await resolveFunction(undefined as any, "helloWorld");
    out.functions.helloWorld = {
      functionRid: hello.functionRid,
      apiName: hello.apiName,
      branch: "main",
      v1: await resolveVersion(hello.functionRid, "1.0.0"),
    };
    const typed = await resolveFunction(undefined as any, "typedParams");
    out.functions.typedParams = {
      functionRid: typed.functionRid,
      apiName: typed.apiName,
      branch: "main",
      v1: await resolveVersion(typed.functionRid, "1.0.0"),
    };
  })();
  require("fs").mkdirSync("/tmp/automate-verify-stack", { recursive: true });
  require("fs").writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`seed-domain: wrote ${OUT_FILE}`);
  console.log(JSON.stringify({
    ontologyId: out.ontologyId,
    repositoryRid: out.repositoryRid,
    verifyMarker: out.functions.verifyMarker.functionRid,
    markerV2: out.functions.verifyMarker.v2.semver,
  }, null, 2));
}

main().catch((e) => {
  console.error("seed-domain: FATAL", e instanceof Error ? e.message : e);
  process.exit(1);
});
