#!/usr/bin/env -S pnpm tsx
/**
 * FOUNDRY-GAPS §5 — OSDK regeneration CLI.
 *
 * Loads an ontology snapshot from PostgreSQL (env-driven: PGHOST/PGPORT/
 * PGDATABASE/PGUSER/PGPASSWORD — same pool config as the server, via
 * src/db.ts), runs the pure codegen core (src/services/osdk/generator.ts)
 * and writes the typed SDK under `generated/osdk/<ontologyApiName>/`.
 *
 * Invoked two ways:
 *   1. Directly by app builders / CI:
 *        npx tsx scripts/osdk-regen.ts --ontology <ontologyId>
 *        npx tsx scripts/osdk-regen.ts --all
 *   2. By the B10 regen hook (src/services/ontology-bindings/osdk-regen.ts),
 *      which spawns `node -r ts-node/register scripts/osdk-regen.ts
 *      --binding <bindingRid>` and treats exit code 0 as success. The hook
 *      derives its own `osdk-{rid.slice(-8)}-{timestamp}` tag; we print the
 *      same-format tag on stdout (last line: `osdk_version=<tag>`) so callers
 *      that parse output get an identical contract.
 *
 * Options:
 *   --ontology <id>   Regenerate one ontology.
 *   --binding <rid>   Regenerate the ontology owning the bound object type
 *                     (falls back to --all when the binding cannot be
 *                     resolved — a superset regen is always safe).
 *   --all             Regenerate every ontology.
 *   --out <dir>       Output root (default: <repo>/generated/osdk).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pool, query } from "../src/db";
import {
  generateOsdk,
  sanitizeIdentifier,
  type OntologySnapshot,
  type SnapshotObjectType,
} from "../src/services/osdk/generator";
import { generateOsdkPython } from "../src/services/osdk/pythonGenerator";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type OsdkLang = "ts" | "python" | "both";

interface CliArgs {
  ontology?: string;
  binding?: string;
  all: boolean;
  out: string;
  lang: OsdkLang;
}

const USAGE =
  "Usage: npx tsx scripts/osdk-regen.ts --ontology <id> | --binding <rid> | --all " +
  "[--out <dir>] [--lang ts|python|both]";

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    all: false,
    out: path.resolve(process.cwd(), "generated/osdk"),
    lang: "ts",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ontology") args.ontology = argv[++i];
    else if (a === "--binding") args.binding = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--lang") {
      const v = argv[++i];
      if (v !== "ts" && v !== "python" && v !== "both") {
        console.error(`Invalid --lang '${v}' (expected ts|python|both)`);
        process.exit(2);
      }
      args.lang = v;
    } else {
      console.error(`Unknown argument: ${a}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (!args.ontology && !args.binding && !args.all) {
    console.error(USAGE);
    process.exit(2);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Snapshot loading
// ---------------------------------------------------------------------------

async function loadSnapshot(ontologyId: string): Promise<OntologySnapshot | null> {
  const ont = await query(
    `SELECT ontology_id, display_name, description, updated_at
       FROM ontology WHERE ontology_id = $1`,
    [ontologyId],
  );
  if (ont.rows.length === 0) return null;
  const o = ont.rows[0];

  const otRows = await query(
    `SELECT ot.object_type_id, ot.api_name, ot.display_name, ot.version,
            pk.api_name AS pk_api_name
       FROM object_type ot
       LEFT JOIN property pk ON pk.property_id = ot.primary_key_property_id
      WHERE ot.ontology_id = $1
      ORDER BY ot.api_name`,
    [ontologyId],
  );

  const propRows = await query(
    `SELECT p.object_type_id, p.api_name, p.base_type, p.is_required
       FROM property p
       JOIN object_type ot ON ot.object_type_id = p.object_type_id
      WHERE ot.ontology_id = $1
      ORDER BY p.api_name`,
    [ontologyId],
  );
  const propsByOt = new Map<string, Array<{ apiName: string; type: string; nullable: boolean }>>();
  for (const r of propRows.rows) {
    const list = propsByOt.get(r.object_type_id) ?? [];
    list.push({ apiName: r.api_name, type: r.base_type, nullable: !r.is_required });
    propsByOt.set(r.object_type_id, list);
  }

  const objectTypes: SnapshotObjectType[] = otRows.rows.map((r: any) => ({
    apiName: r.api_name,
    displayName: r.display_name,
    primaryKey: r.pk_api_name ?? "id",
    properties: propsByOt.get(r.object_type_id) ?? [],
  }));

  const ltRows = await query(
    `SELECT lt.api_name, lt.display_name, lt.cardinality,
            src.api_name AS source_api_name, tgt.api_name AS target_api_name
       FROM link_type lt
       JOIN object_type src ON src.object_type_id = lt.source_object_type
       JOIN object_type tgt ON tgt.object_type_id = lt.target_object_type
      WHERE lt.ontology_id = $1
      ORDER BY lt.api_name`,
    [ontologyId],
  );

  const atRows = await query(
    `SELECT api_name, display_name, parameters
       FROM action_type
      WHERE ontology_id = $1
      ORDER BY api_name`,
    [ontologyId],
  );

  return {
    ontology: {
      id: o.ontology_id,
      apiName: sanitizeIdentifier(o.display_name ?? o.ontology_id),
      displayName: o.display_name,
      version: typeof o.updated_at === "string" ? o.updated_at : String(o.updated_at ?? "unversioned"),
      generatedAt: new Date().toISOString(),
    },
    objectTypes,
    linkTypes: ltRows.rows.map((r: any) => ({
      apiName: r.api_name,
      displayName: r.display_name,
      cardinality: r.cardinality,
      sourceObjectType: r.source_api_name,
      targetObjectType: r.target_api_name,
    })),
    actionTypes: atRows.rows.map((r: any) => {
      const params = typeof r.parameters === "string" ? JSON.parse(r.parameters) : (r.parameters ?? []);
      return {
        apiName: r.api_name,
        displayName: r.display_name,
        parameters: (Array.isArray(params) ? params : []).map((p: any) => ({
          apiName: p.apiName ?? p.api_name ?? "param",
          type: p.type ?? "string",
          required: Boolean(p.required),
          objectType: p.objectType,
        })),
      };
    }),
  };
}

/**
 * Resolve a B10 binding rid to the ontology that owns the bound object type.
 * Binding rids look like `ri.ontology.main.binding.<id>` and reference an
 * `object_type_rid`. Resolution is best-effort: any failure returns null and
 * the caller falls back to regenerating all ontologies.
 */
async function resolveBindingToOntology(bindingRid: string): Promise<string | null> {
  try {
    const b = await query(
      `SELECT object_type_rid FROM ontology_bindings WHERE rid = $1 AND deleted_at IS NULL`,
      [bindingRid],
    );
    if (b.rows.length === 0) return null;
    const objectTypeRid: string = b.rows[0].object_type_rid;
    // The rid's last path segment is conventionally the object_type uuid.
    const tail = objectTypeRid.split(".").pop() ?? objectTypeRid;
    const ot = await query(
      `SELECT ontology_id FROM object_type
        WHERE object_type_id::text = $1 OR object_type_id::text = $2 OR api_name = $2
        LIMIT 1`,
      [objectTypeRid, tail],
    );
    return ot.rows.length > 0 ? ot.rows[0].ontology_id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function writeSdk(outRoot: string, snapshot: OntologySnapshot, lang: OsdkLang): string[] {
  const dirName = snapshot.ontology.apiName ?? sanitizeIdentifier(snapshot.ontology.id);
  const base = path.join(outRoot, dirName);
  const written: string[] = [];
  if (lang === "ts" || lang === "both") {
    fs.mkdirSync(base, { recursive: true });
    for (const file of generateOsdk(snapshot)) {
      fs.writeFileSync(path.join(base, file.path), file.content, "utf8");
    }
    written.push(base);
  }
  if (lang === "python" || lang === "both") {
    // Python flavor lands in a `python/` subdir so both can coexist per ontology.
    const pyDir = path.join(base, "python");
    fs.mkdirSync(pyDir, { recursive: true });
    for (const file of generateOsdkPython(snapshot)) {
      fs.writeFileSync(path.join(pyDir, file.path), file.content, "utf8");
    }
    written.push(pyDir);
  }
  return written;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let ontologyIds: string[] = [];
  if (args.ontology) {
    ontologyIds = [args.ontology];
  } else if (args.binding) {
    const resolved = await resolveBindingToOntology(args.binding);
    if (resolved) {
      ontologyIds = [resolved];
    } else {
      console.warn(`[osdk-regen] could not resolve binding ${args.binding} — regenerating all ontologies`);
      args.all = true;
    }
  }
  if (args.all && ontologyIds.length === 0) {
    const res = await query(`SELECT ontology_id FROM ontology ORDER BY display_name`);
    ontologyIds = res.rows.map((r: any) => r.ontology_id);
  }

  if (ontologyIds.length === 0) {
    console.warn("[osdk-regen] no ontologies found — nothing to generate");
  }

  for (const id of ontologyIds) {
    const snapshot = await loadSnapshot(id);
    if (!snapshot) {
      throw new Error(`Ontology not found: ${id}`);
    }
    const dirs = writeSdk(args.out, snapshot, args.lang);
    console.log(
      `[osdk-regen] ${snapshot.ontology.displayName ?? id} (${args.lang}): ` +
        `${snapshot.objectTypes.length} object types, ${snapshot.linkTypes.length} link types, ` +
        `${snapshot.actionTypes.length} action types → ${dirs.join(", ")}`,
    );
  }

  // Version tag — same format the regen hook derives (`osdk-{suffix}-{ts}`).
  const seed = args.binding ?? args.ontology ?? "all";
  const versionTag = `osdk-${seed.slice(-8)}-${Date.now()}`;
  console.log(`osdk_version=${versionTag}`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`[osdk-regen] failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
