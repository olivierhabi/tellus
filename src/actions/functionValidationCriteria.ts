import { query } from "../db";
import { runSandboxed } from "../services/functionRuntime";

type Binding =
  | { source: "parameter"; parameter: string }
  | { source: "static"; value: unknown }
  | { source: "objectProperty"; parameter: string; objectType: string; property: string };
type FunctionCondition = {
  functionValidation?: {
    apiName: string;
    version: number;
    input: Record<string, Binding>;
    resultField: string;
  };
  description?: string;
};

function conditions(criteria: unknown): FunctionCondition[] {
  if (Array.isArray(criteria)) return criteria as FunctionCondition[];
  if (criteria && typeof criteria === "object" && Array.isArray((criteria as { conditions?: unknown }).conditions)) {
    return (criteria as { conditions: FunctionCondition[] }).conditions;
  }
  return [];
}

/** Execute immutable, pinned pure functions used as action submission gates. */
export async function evaluateFunctionValidationCriteria(
  ontologyId: string,
  criteria: unknown,
  parameters: Record<string, unknown>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const condition of conditions(criteria)) {
    const config = condition.functionValidation;
    if (!config) continue;
    const published = await query(
      `SELECT v.source_code
         FROM ontology_function f
         JOIN ontology_function_version v ON v.function_id = f.function_id
        WHERE f.ontology_id = $1 AND f.api_name = $2 AND v.version_number = $3`,
      [ontologyId, config.apiName, config.version],
    );
    if ((published.rowCount ?? 0) !== 1) {
      failures.push(condition.description ?? `Pinned function ${config.apiName}@${config.version} is unavailable`);
      continue;
    }
    const inputEntries: Array<[string, unknown]> = [];
    for (const [name, binding] of Object.entries(config.input)) {
      if (binding.source === "parameter") inputEntries.push([name, parameters[binding.parameter]]);
      else if (binding.source === "static") inputEntries.push([name, binding.value]);
      else {
        const object = await query(
          `SELECT properties FROM object_instances
            WHERE object_type_api_name = $1 AND primary_key = $2`,
          [binding.objectType, String(parameters[binding.parameter] ?? "")],
        );
        inputEntries.push([name, object.rows[0]?.properties?.[binding.property]]);
      }
    }
    const input = Object.fromEntries(inputEntries);
    const result = runSandboxed(String(published.rows[0].source_code), input);
    const output = result.output as Record<string, unknown> | null;
    if (result.status !== "ok" || output?.[config.resultField] !== true) {
      failures.push(condition.description ?? `${config.apiName} rejected the action`);
    }
  }
  return failures;
}
