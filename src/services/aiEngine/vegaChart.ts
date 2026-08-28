import type {
  VegaChartAgentPayload,
  VegaChartAgentResult,
} from "./client";

export interface VegaChartProperty {
  apiName: string;
  displayName?: string;
  baseType: string;
}

export interface VegaChartGenerationRequest {
  prompt: string;
  objectTypeApiName?: string;
  properties?: readonly VegaChartProperty[];
  dataName: string;
  dataInputs?: ReadonlyArray<{
    name: string;
    dataSource: "aggregation" | "object-set" | "function";
  }>;
  groupByProperties?: ReadonlyArray<{
    id: string;
    identifier: string;
    propertyApiName: string | null;
  }>;
  dataSource?: "aggregation" | "object-set" | "function";
  aggregation?: "count" | "sum" | "avg" | "min" | "max" | "cardinality";
  aggregationProperty?: string | null;
  aggregationName?: string;
  specLanguage?: "vega-lite" | "vega";
  currentSpec?: string;
  model?: string;
}

function vegaType(baseType: string): string {
  // Workshop geoshape properties contain GeoJSON geometry/features and must
  // be exposed to the chart agent as such. Treating them as nominal invites a
  // model to emit a compiling-but-blank geoshape over district labels.
  if (/^(geoshape|geo_shape|geojson)$/i.test(baseType)) {
    return "geojson";
  }
  if (/^(integer|long|float|double|decimal)$/i.test(baseType)) {
    return "quantitative";
  }
  if (/^(date|timestamp|localdate|localdatetime)$/i.test(baseType)) {
    return "temporal";
  }
  return "nominal";
}

/** Build telos-AIE-agent's POST /api/vega-chart payload from Workshop config. */
export function buildVegaChartAgentPayload(
  input: VegaChartGenerationRequest,
): VegaChartAgentPayload {
  const configuredNames = (input.dataInputs ?? [])
    .map(({ name }) => name.trim())
    .filter(Boolean);
  const primaryDataName = input.dataName.trim() || configuredNames[0] || "objects";
  const allDataNames = Array.from(new Set([primaryDataName, ...configuredNames]));
  const groupBy = (input.groupByProperties ?? []).filter(
    ({ propertyApiName }) => propertyApiName,
  );
  const aggregationName = input.aggregationName?.trim() || "value";
  const isAggregation = input.dataSource === "aggregation";

  const rawFields = (input.properties ?? []).map((property) => {
    const label = property.displayName?.trim();
    return `${property.apiName} (${vegaType(property.baseType)}${
      label && label !== property.apiName ? `; label: ${label}` : ""
    })`;
  });
  const groupFields = groupBy.map(({ identifier, propertyApiName }, index) => {
    const outputName = identifier.trim() || propertyApiName!;
    return `${outputName} (nominal; Group by ${index + 1}; source property: ${propertyApiName})`;
  });
  const availableFields = isAggregation
    ? Array.from(
        new Set([
          "key (nominal; canonical primary group value)",
          "value (quantitative; canonical aggregate value)",
          ...groupFields,
          `${aggregationName} (quantitative; named aggregate value)`,
        ]),
      )
    : rawFields;
  const groupDescription = groupBy.length
    ? groupBy
        .map(({ identifier, propertyApiName }, index) => {
          const outputName = identifier.trim() || propertyApiName!;
          return `${index + 1}. output field "${outputName}" from property "${propertyApiName}"`;
        })
        .join("; ")
    : "none";
  const aggregationDescription = isAggregation
    ? `${input.aggregation ?? "count"}${
        input.aggregationProperty ? ` of "${input.aggregationProperty}"` : ""
      }, exposed as "${aggregationName}" and canonical "value"`
    : "not applicable";

  return {
    user_request: [
      "Create a production-quality Vega-Lite v6.1.2 JSON specification for Tellus Workshop.",
      `Use the named data input "${primaryDataName}" exactly as {"data":{"name":"${primaryDataName}"}}.`,
      "Do not inline data with values or url, and do not invent field names.",
      `Configured data inputs: ${allDataNames.map((name) => `"${name}"`).join(", ")}.`,
      `Data source mode: ${input.dataSource ?? "aggregation"}.`,
      `Ordered Group by fields: ${groupDescription}.`,
      `Aggregation: ${aggregationDescription}.`,
      `User request: ${input.prompt.trim()}`,
    ].join(" "),
    data_fields: [
      `Object type: ${input.objectTypeApiName?.trim() || "not specified"}`,
      `Data input name: ${primaryDataName}`,
      `Available injected row fields: ${availableFields.join(", ") || "not specified"}`,
      ...(isAggregation
        ? [
            `Object properties available for configuring aggregation: ${
              rawFields.join(", ") || "not specified"
            }`,
          ]
        : []),
    ].join(". "),
    ...(input.currentSpec?.trim() ? { current_json: input.currentSpec } : {}),
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
  };
}

export interface VegaChartGenerationResult {
  spec: string;
  _metadata?: Record<string, unknown>;
}

/** Validate the model response and enforce the configured named dataset. */
export function normalizeVegaChartAgentResult(
  result: VegaChartAgentResult,
  dataName: string,
): VegaChartGenerationResult {
  let raw = result.response;
  if (typeof raw === "string") {
    const withoutFence = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    try {
      raw = JSON.parse(withoutFence);
    } catch {
      throw new Error("AI engine returned an invalid Vega JSON response.");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("AI engine returned no Vega specification.");
  }

  const spec = { ...(raw as Record<string, unknown>) };
  const embeddedMetadata = spec._metadata;
  delete spec._metadata;
  const currentData =
    spec.data && typeof spec.data === "object" && !Array.isArray(spec.data)
      ? (spec.data as Record<string, unknown>)
      : {};
  const safeData = { ...currentData };
  delete safeData.values;
  delete safeData.url;
  spec.data = { ...safeData, name: dataName.trim() };
  if (typeof spec.$schema !== "string") {
    spec.$schema = "https://vega.github.io/schema/vega-lite/v6.json";
  }

  const metadata =
    embeddedMetadata && typeof embeddedMetadata === "object"
      ? (embeddedMetadata as Record<string, unknown>)
      : result._metadata;
  return {
    spec: JSON.stringify(spec, null, 2),
    ...(metadata ? { _metadata: metadata } : {}),
  };
}
