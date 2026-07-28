/**
 * FOUNDRY-GAPS §5 — OSDK generator unit tests (pure, no DB / no server).
 *
 * Feeds a fixture OntologySnapshot through the codegen core and asserts:
 *   - generated interfaces contain the expected declarations + type mapping
 *   - identifier sanitization (`flight-data 2024` → FlightData2024)
 *   - determinism (two runs produce byte-identical output)
 *   - client method paths match the live REST routes (src/routes/objects.ts,
 *     mirroring tellus-fe/lib/ontologyApi.ts)
 *   - primary-key typing flows through to ObjectSet accessors
 *   - generated sources transpile cleanly (ts.transpileModule)
 */
import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import {
  generateOsdk,
  sanitizeIdentifier,
  pascalCase,
  mapPropertyType,
  type OntologySnapshot,
} from "../../../src/services/osdk/generator";

const fixture: OntologySnapshot = {
  ontology: {
    id: "11111111-2222-3333-4444-555555555555",
    apiName: "aviation",
    displayName: "Aviation",
    version: "2026-06-10T00:00:00.000Z",
    generatedAt: "2026-06-10T12:00:00.000Z",
  },
  objectTypes: [
    {
      apiName: "flight-data 2024", // requires sanitization
      displayName: "Flight Data 2024",
      primaryKey: "flightId",
      properties: [
        { apiName: "flightId", type: "string", nullable: false },
        { apiName: "passengerCount", type: "integer", nullable: true },
        { apiName: "distanceKm", type: "double", nullable: true },
        { apiName: "delayed", type: "boolean", nullable: true },
        { apiName: "departureDate", type: "date", nullable: true },
        { apiName: "lastSeen", type: "timestamp", nullable: true },
        { apiName: "tags", type: "string_array", nullable: true },
      ],
    },
    {
      apiName: "airport",
      displayName: "Airport",
      primaryKey: "code",
      properties: [
        { apiName: "code", type: "string", nullable: false },
        { apiName: "elevation", type: "long", nullable: true },
        { apiName: "isInternational", type: "boolean", nullable: false },
        { apiName: "openedOn", type: "date", nullable: true },
        { apiName: "updatedAt", type: "timestamp", nullable: false },
        { apiName: "rating", type: "float", nullable: true },
      ],
    },
  ],
  linkTypes: [
    {
      apiName: "flightToAirport",
      displayName: "Flight → Airport",
      cardinality: "MANY_TO_ONE",
      sourceObjectType: "flight-data 2024",
      targetObjectType: "airport",
    },
  ],
  actionTypes: [
    {
      apiName: "create-flight",
      displayName: "Create Flight",
      parameters: [
        { apiName: "flightId", type: "string", required: true },
        { apiName: "passengerCount", type: "integer", required: false },
        { apiName: "airport", type: "object_reference", required: true, objectType: "airport" },
      ],
    },
  ],
};

function fileContent(files: ReturnType<typeof generateOsdk>, path: string): string {
  const f = files.find((x) => x.path === path);
  expect(f, `expected generated file ${path}`).toBeDefined();
  return f!.content;
}

describe("osdk generator — identifier sanitization", () => {
  it("camelCases arbitrary apiNames into valid TS identifiers", () => {
    expect(sanitizeIdentifier("flight-data 2024")).toBe("flightData2024");
    expect(sanitizeIdentifier("create-flight")).toBe("createFlight");
    expect(sanitizeIdentifier("2024 flights")).toBe("_2024Flights");
    expect(sanitizeIdentifier("class")).toBe("class_");
  });

  it("PascalCases type names", () => {
    expect(pascalCase("flight-data 2024")).toBe("FlightData2024");
    expect(pascalCase("airport")).toBe("Airport");
  });
});

describe("osdk generator — property type mapping", () => {
  it("maps ontology base types to TS types", () => {
    expect(mapPropertyType("string")).toBe("string");
    expect(mapPropertyType("integer")).toBe("number");
    expect(mapPropertyType("long")).toBe("number");
    expect(mapPropertyType("double")).toBe("number");
    expect(mapPropertyType("float")).toBe("number");
    expect(mapPropertyType("boolean")).toBe("boolean");
    expect(mapPropertyType("date")).toBe("string"); // ISO 8601
    expect(mapPropertyType("timestamp")).toBe("string"); // ISO 8601
    expect(mapPropertyType("string_array")).toBe("string[]");
  });
});

describe("osdk generator — types.ts", () => {
  const files = generateOsdk(fixture);
  const types = fileContent(files, "types.ts");

  it("emits one interface per object type with sanitized names", () => {
    expect(types).toContain("export interface FlightData2024 {");
    expect(types).toContain("export interface Airport {");
  });

  it("maps property types per spec", () => {
    expect(types).toContain("flightId: string;");
    expect(types).toContain("passengerCount?: number | null;");
    expect(types).toContain("distanceKm?: number | null;");
    expect(types).toContain("delayed?: boolean | null;");
    expect(types).toContain("departureDate?: string | null;");
    expect(types).toContain("lastSeen?: string | null;");
    expect(types).toContain("tags?: string[] | null;");
    expect(types).toContain("isInternational: boolean;");
    expect(types).toContain("updatedAt: string;");
  });

  it("emits primary-key type aliases derived from the pk property type", () => {
    expect(types).toContain("export type FlightData2024PrimaryKey = string;");
    expect(types).toContain("export type AirportPrimaryKey = string;");
  });

  it("emits link type descriptors with raw apiNames preserved", () => {
    expect(types).toContain("export const LINK_TYPES = {");
    expect(types).toContain('apiName: "flightToAirport"');
    expect(types).toContain('cardinality: "MANY_TO_ONE"');
    expect(types).toContain('sourceObjectType: "flight-data 2024"');
    expect(types).toContain('targetObjectType: "airport"');
  });

  it("emits action parameter interfaces with required/optional split", () => {
    expect(types).toContain("export interface CreateFlightParameters {");
    expect(types).toContain("flightId: string;");
    expect(types).toContain("passengerCount?: number;");
    expect(types).toContain("airport: string | number;"); // object_reference → pk
  });

  it("embeds the ontology version + timestamp in the header", () => {
    expect(types).toContain("Version: 2026-06-10T00:00:00.000Z");
    expect(types).toContain("Generated at: 2026-06-10T12:00:00.000Z");
  });
});

describe("osdk generator — client.ts REST paths", () => {
  const files = generateOsdk(fixture);
  const client = fileContent(files, "client.ts");

  it("hits the same data-plane routes the FE uses (lib/ontologyApi.ts)", () => {
    // GET /v1/objects/:apiName (fetchPage), GET /v1/objects/:apiName/:pk (get)
    expect(client).toContain("/v1/objects/${encodeURIComponent(this.apiName)}");
    expect(client).toContain(
      "/v1/objects/${encodeURIComponent(this.apiName)}/${encodeURIComponent(String(primaryKey))}",
    );
    // POST /v1/objects/:apiName/search and /aggregate
    expect(client).toContain("/v1/objects/${encodeURIComponent(this.apiName)}/search");
    expect(client).toContain("/v1/objects/${encodeURIComponent(this.apiName)}/aggregate");
    // POST /v1/ontology/:ontologyId/actions/:apiName/apply
    expect(client).toContain(
      "/v1/ontology/${encodeURIComponent(this.ontologyId)}/actions/${encodeURIComponent(actionApiName)}/apply",
    );
    // GET /v1/objects/:src/:pk/links/:linkApiName
    expect(client).toContain("/links/${encodeURIComponent(linkApiName)}");
  });

  it("registers object sets under sanitized accessors with raw apiNames in URLs", () => {
    expect(client).toContain(
      'FlightData2024: new ObjectSet<T.FlightData2024, T.FlightData2024PrimaryKey>(this.core, "flight-data 2024")',
    );
    expect(client).toContain(
      'Airport: new ObjectSet<T.Airport, T.AirportPrimaryKey>(this.core, "airport")',
    );
  });

  it("types per-object accessors with the primary-key alias", () => {
    expect(client).toContain("FlightData2024: ObjectSet<T.FlightData2024, T.FlightData2024PrimaryKey>;");
    expect(client).toContain("Airport: ObjectSet<T.Airport, T.AirportPrimaryKey>;");
  });

  it("emits typed action invokers", () => {
    expect(client).toContain("createFlight(params: T.CreateFlightParameters): Promise<unknown>;");
    expect(client).toContain('this.applyAction("create-flight"');
  });

  it("emits typed link traversal helpers (source pk in, target page out)", () => {
    expect(client).toContain(
      "flightToAirport(sourcePrimaryKey: T.FlightData2024PrimaryKey, opts?: LinkTraversalOptions): Promise<PageResult<T.Airport>>;",
    );
    expect(client).toContain('traverseLink<T.Airport>(this.core, "flight-data 2024", "flightToAirport"');
  });

  it("bakes in the ontology id for action apply", () => {
    expect(client).toContain(
      'export const DEFAULT_ONTOLOGY_ID = "11111111-2222-3333-4444-555555555555";',
    );
  });
});

describe("osdk generator — determinism", () => {
  it("two runs over the same snapshot are byte-identical", () => {
    const a = generateOsdk(fixture);
    const b = generateOsdk(fixture);
    expect(a.map((f) => f.path)).toEqual(b.map((f) => f.path));
    for (let i = 0; i < a.length; i++) {
      expect(a[i].content).toBe(b[i].content);
    }
  });

  it("input ordering does not change output (stable sort by apiName)", () => {
    const shuffled: OntologySnapshot = {
      ...fixture,
      objectTypes: [...fixture.objectTypes].reverse().map((ot) => ({
        ...ot,
        properties: [...ot.properties].reverse(),
      })),
      actionTypes: [...fixture.actionTypes].reverse(),
      linkTypes: [...fixture.linkTypes].reverse(),
    };
    const a = generateOsdk(fixture);
    const b = generateOsdk(shuffled);
    for (let i = 0; i < a.length; i++) {
      expect(b[i].content).toBe(a[i].content);
    }
  });
});

describe("osdk generator — index.ts barrel", () => {
  it("re-exports types and client with a README header", () => {
    const files = generateOsdk(fixture);
    const index = fileContent(files, "index.ts");
    expect(index).toContain('export * from "./types.js";');
    expect(index).toContain('export * from "./client.js";');
    expect(index).toContain("README");
    expect(index).toContain("Ontology id: 11111111-2222-3333-4444-555555555555");
    expect(index).toContain("Generated:   2026-06-10T12:00:00.000Z");
  });
});

describe("osdk generator — durable subscription recovery", () => {
  it("refreshes once when a resume cursor has expired", () => {
    const files = generateOsdk(fixture);
    const client = fileContent(files, "clientV2.ts");
    expect(client).toContain(
      'protocolError?.error === "SubscriptionCursorExpired"',
    );
    expect(client).toContain(
      'ws.send(JSON.stringify({ type: "subscribeRequests", ...request }))',
    );
  });
});

describe("osdk generator — generated sources transpile", () => {
  it("every generated file passes ts.transpileModule without syntax diagnostics", () => {
    const files = generateOsdk(fixture);
    for (const f of files.filter((file) => file.path.endsWith(".ts"))) {
      const result = ts.transpileModule(f.content, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2020,
          strict: true,
        },
        reportDiagnostics: true,
      });
      const errors = (result.diagnostics ?? []).map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      );
      expect(errors, `${f.path}: ${errors.join("; ")}`).toEqual([]);
      expect(result.outputText.length).toBeGreaterThan(0);
    }
  });
});
