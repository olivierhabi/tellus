import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pool, query } from "../db";
import {
  generateOsdk,
  type OntologySnapshot,
} from "../services/osdk/generator";

async function main(): Promise<void> {
  const ontologyId = process.argv[2];
  const outputDirectory = process.argv[3];
  if (!ontologyId || !outputDirectory || !path.isAbsolute(outputDirectory)) {
    throw new Error(
      "usage: tsx src/scripts/generateOssV2SdkPackage.ts <ontology-uuid> <absolute-output-directory>",
    );
  }
  const ontology = await query(
    `SELECT ontology_id, display_name, updated_at
       FROM ontology
      WHERE ontology_id = $1`,
    [ontologyId],
  );
  if (ontology.rows.length === 0) throw new Error("ontology not found");
  const objectTypes = await query(
    `SELECT ot.object_type_id, ot.api_name, ot.display_name,
            primary_property.api_name AS primary_key
       FROM object_type ot
       LEFT JOIN property primary_property
         ON primary_property.property_id = ot.primary_key_property_id
      WHERE ot.ontology_id = $1
      ORDER BY ot.api_name`,
    [ontologyId],
  );
  const properties = await query(
    `SELECT ot.object_type_id, p.api_name, p.base_type, p.is_required
       FROM property p
       JOIN object_type ot ON ot.object_type_id = p.object_type_id
      WHERE ot.ontology_id = $1
      ORDER BY ot.api_name, p.ordinal, p.api_name`,
    [ontologyId],
  );
  const propertiesByType = new Map<
    string,
    Array<{ apiName: string; type: string; nullable: boolean }>
  >();
  for (const property of properties.rows) {
    const list = propertiesByType.get(String(property.object_type_id)) ?? [];
    list.push({
      apiName: String(property.api_name),
      type: String(property.base_type),
      nullable: property.is_required !== true,
    });
    propertiesByType.set(String(property.object_type_id), list);
  }
  const links = await query(
    `SELECT lt.api_name, lt.display_name, lt.cardinality,
            source.api_name AS source_type, target.api_name AS target_type
       FROM link_type lt
       JOIN object_type source
         ON source.object_type_id = lt.source_object_type
       JOIN object_type target
         ON target.object_type_id = lt.target_object_type
      WHERE lt.ontology_id = $1
      ORDER BY lt.api_name`,
    [ontologyId],
  );
  const actions = await query(
    `SELECT api_name, display_name, parameters
       FROM action_type
      WHERE ontology_id = $1
      ORDER BY api_name`,
    [ontologyId],
  );
  const snapshot: OntologySnapshot = {
    ontology: {
      id: ontologyId,
      apiName: "tellus-live",
      displayName: String(ontology.rows[0].display_name),
      version: new Date(ontology.rows[0].updated_at).getTime(),
      generatedAt: new Date().toISOString(),
    },
    objectTypes: objectTypes.rows.map((objectType) => ({
      apiName: String(objectType.api_name),
      displayName: String(objectType.display_name),
      primaryKey: String(objectType.primary_key ?? "__primaryKey"),
      properties:
        propertiesByType.get(String(objectType.object_type_id)) ?? [],
    })),
    linkTypes: links.rows.map((link) => ({
      apiName: String(link.api_name),
      displayName: String(link.display_name),
      cardinality: String(link.cardinality),
      sourceObjectType: String(link.source_type),
      targetObjectType: String(link.target_type),
    })),
    actionTypes: actions.rows.map((action) => ({
      apiName: String(action.api_name),
      displayName: String(action.display_name),
      parameters: (
        Array.isArray(action.parameters) ? action.parameters : []
      ).map((parameter: Record<string, unknown>) => ({
        apiName: String(parameter.apiName),
        type: String(parameter.type),
        required: parameter.required === true,
        objectType:
          typeof parameter.objectType === "string"
            ? parameter.objectType
            : undefined,
      })),
    })),
  };
  await mkdir(outputDirectory, { recursive: true });
  const files = generateOsdk(snapshot);
  for (const file of files) {
    const target = path.join(outputDirectory, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  process.stdout.write(
    JSON.stringify({
      outputDirectory,
      files: files.map((file) => file.path),
      objectTypes: snapshot.objectTypes.length,
      linkTypes: snapshot.linkTypes.length,
      actionTypes: snapshot.actionTypes.length,
    }) + "\n",
  );
  await pool.end();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  void pool.end().finally(() => process.exit(1));
});
