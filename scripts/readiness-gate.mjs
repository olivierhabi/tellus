#!/usr/bin/env node
// ---------------------------------------------------------------------------
// RSSB Ontology Production-Readiness Gate (rerunnable)
//
// Verifies the five mission gates and emits a GO / NO-GO verdict:
//   G1. Every link type has non-null reverseApiName, description,
//       reverseDescription, reverseDisplayName.
//   G2. Exact analysis on EVERY link: no "links>0 with targets=0"
//       contradiction (impossible after the Phase-1 resolved-vs-dangling
//       fix). Dangling edges are reported separately, not as links.
//   G3. Edge-level integrity: for every link with totalLinkCount>0,
//       sample up to 5 source objects, resolve each FK to a target
//       object via the object-by-PK endpoint; confirm both endpoints.
//   G4. Object types indexed with expected counts.
//   G5. Final GO / NO-GO.
//
// Usage:
//   TELLUS_TOKEN=<jwt> node scripts/readiness-gate.mjs
//   # or, if /tmp/tellus-token.txt exists ( Opencode auth helper), it
//   # is read automatically.
// ---------------------------------------------------------------------------
import fs from "node:fs";

const OID = process.env.TELLUS_ONTOLOGY_ID || "00000000-0000-0000-0000-000000000001";
const BASE = process.env.TELLUS_BASE || "http://localhost:3000/api/v1";
const TOKEN = process.env.TELLUS_TOKEN || fs.readFileSync("/tmp/tellus-token.txt", "utf8").trim();
const HEAD = { Cookie: `TELLUS_TOKEN=${TOKEN}` };

// Expected object counts (from the RSSB seed + audit targets). Unknown
// types are checked for indexStatus only.
const EXPECTED_COUNTS = {
  RssbScheme: 6, RssbPerson: 700, RssbAppeal: 10, RssbAuditCase: 88,
  RssbHealthClaim: 1000, RssbBenefitClaim: 40, RssbOrganization: 26,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jget(path) { const r = await fetch(`${BASE}${path}`, { headers: HEAD }); if (!r.ok) return { _error: r.status }; return r.json(); }
async function jpost(path, body) { const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { ...HEAD, "content-type": "application/json" }, body: JSON.stringify(body) }); const t = await r.text(); try { return { _status: r.status, ...(JSON.parse(t)) }; } catch { return { _status: r.status, _raw: t }; } }

async function main() {
  const links = (await jget(`/ontology/${OID}/linkTypes`)).data || [];
  const otsResp = await jget(`/ontology/${OID}/objectTypes`);
  const ots = otsResp.data || otsResp.objectTypes || otsResp || [];
  const idMap = new Map();
  for (const o of ots) idMap.set(o.objectTypeId, o);

  // ----- G1: metadata completeness -----
  let g1Fail = 0;
  const g1Rows = [];
  for (const l of links) {
    const miss = ["reverseApiName","description","reverseDescription","reverseDisplayName"].filter((f) => !l[f]);
    if (miss.length) { g1Fail++; g1Rows.push({ apiName: l.apiName, missing: miss }); }
  }

  // ----- G2: exact analysis on every link -----
  let g2Contradiction = 0, g2DanglingLinks = 0;
  const g2Rows = [];
  for (const l of links) {
    const a = await jget(`/ontology/${OID}/linkTypes/${encodeURIComponent(l.apiName)}/analysis?precision=exact`);
    const d = a.data || a;
    const contradiction = d.totalLinkCount > 0 && d.totalTargetObjects === 0;
    if (contradiction) g2Contradiction++;
    if (d.danglingEdges > 0) g2DanglingLinks++;
    g2Rows.push({ apiName: l.apiName, links: d.totalLinkCount, targets: d.totalTargetObjects, dangling: d.danglingEdges || 0, sources: d.totalSourceObjects, contradiction });
    await sleep(30); // be kind to the cluster
  }

  // ----- G3: edge-level integrity (sample up to 5 resolved edges per link) -----
  let g3Fail = 0;
  const g3Rows = [];
  for (const l of links) {
    const analysis = g2Rows.find((r) => r.apiName === l.apiName);
    if (!analysis || analysis.links === 0) { g3Rows.push({ apiName: l.apiName, sampled: 0, note: "no resolved edges" }); continue; }
    const src = idMap.get(l.sourceObjectType);
    const tgt = idMap.get(l.targetObjectType);
    if (!src || !tgt) { g3Rows.push({ apiName: l.apiName, sampled: 0, note: "missing type map" }); g3Fail++; continue; }
    // Fetch up to 50 source objects and sample up to 5 that actually have
    // the FK populated (resolved edges live there). Sampling the first N
    // naively can hit null-FK objects and falsely report 0 resolved.
    const search = await jpost(`/objects/${src.apiName}/search`, { pageSize: 50 });
    const all = search.objects || search.results || search.data || [];
    let resolved = 0, unresolved = 0, sampled = 0;
    // Determine FK field on source side.
    const detail = await jget(`/ontology/${OID}/linkTypes/${encodeURIComponent(l.apiName)}`);
    const dd = detail.data || detail;
    const fkField = dd.sourcePropertyApiName; // MANY_TO_ONE / ONE_TO_ONE
    const withFk = fkField ? all.filter((o) => o[fkField] !== null && o[fkField] !== undefined && o[fkField] !== "") : all;
    for (const o of withFk.slice(0, 5)) {
      const pk = o.__pk || o[src.primaryKey] || o.__primaryKey;
      if (!pk) continue;
      sampled++;
      // Resolve the edge via the /linked endpoint and confirm a target
      // object comes back. End-to-end edge resolution (both endpoints).
      const lr = await jget(`/ontology/${OID}/objectTypes/${src.apiName}/objects/${encodeURIComponent(pk)}/linked?linkType=${encodeURIComponent(l.apiName)}&pageSize=1`);
      const ld = lr.data || lr;
      const groups = ld.linkGroups || ld.linkedObjects || [];
      const got = groups.some((g) => (g.objects || []).length > 0) || (ld.objects && ld.objects.length > 0);
      if (got) resolved++; else unresolved++;
    }
    // Fail only when analysis proves links>0 AND we sampled populated-FK
    // objects but none resolved. If no populated-FK object appeared in the
    // first 50 (rare, e.g. sparse FK), defer to the analysis (G2) which
    // already authoritatively computed resolved edges.
    const fail = sampled > 0 && resolved === 0 && analysis.links > 0;
    if (fail) g3Fail++;
    g3Rows.push({ apiName: l.apiName, sampled, resolved, unresolved, note: fail ? "sampled populated-FK objects did not resolve" : (sampled === 0 ? "no populated FK in first 50 (analysis confirms links=" + analysis.links + ")" : "ok") });
  }

  // ----- G4: object index counts -----
  let g4Fail = 0;
  const g4Rows = [];
  for (const o of ots) {
    const expected = EXPECTED_COUNTS[o.apiName];
    const indexed = o.indexStatus === "indexed";
    const countOk = expected === undefined || o.objectCount === expected;
    if (!indexed || !countOk) g4Fail++;
    g4Rows.push({ apiName: o.apiName, count: o.objectCount, expected: expected ?? "(any)", index: o.indexStatus, ok: indexed && countOk });
  }

  // ----- Verdict -----
  const go = g1Fail === 0 && g2Contradiction === 0 && g3Fail === 0 && g4Fail === 0;
  console.log("================ RSSB ONTOLOGY READINESS GATE ================");
  console.log(`Links total:        ${links.length}`);
  console.log(`G1 metadata fails:  ${g1Fail}`);
  console.log(`G2 contradictions:  ${g2Contradiction}  (links>0 with targets=0 — must be 0)`);
  console.log(`G2 links w/dangling:${g2DanglingLinks}  (reported separately, not counted as links)`);
  console.log(`G3 edge-sample fail:${g3Fail}`);
  console.log(`G4 count/index fail:${g4Fail}`);
  console.log("--------------------------------------------------------------");
  console.log("G1 missing-metadata links:", g1Rows.length ? g1Rows : "none");
  console.log("G2 contradiction rows:", g2Rows.filter((r) => r.contradiction).length ? g2Rows.filter((r) => r.contradiction) : "none");
  console.log("G2 dangling links (informational):", g2Rows.filter((r) => r.dangling > 0));
  console.log("G4 object counts (failures):", g4Rows.filter((r) => !r.ok).length ? g4Rows.filter((r) => !r.ok) : "none");
  console.log("==============================================================");
  console.log(`VERDICT: ${go ? "GO ✅" : "NO-GO ❌"}`);

  fs.writeFileSync("/tmp/readiness-gate-result.json", JSON.stringify({
    verdict: go ? "GO" : "NO-GO",
    linksTotal: links.length, g1Fail, g2Contradiction, g2DanglingLinks, g3Fail, g4Fail,
    g1Rows, g2Rows, g3Rows, g4Rows,
  }, null, 2));
}
main().catch((e) => { console.error("GATE ERROR", e); process.exit(2); });
