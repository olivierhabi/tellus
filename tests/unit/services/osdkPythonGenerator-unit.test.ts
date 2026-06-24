/**
 * FOUNDRY-GAPS §5 — Python OSDK generator unit tests.
 *
 * Same fixture as the TS flavor. Asserts:
 *   - type mapping (ontology base type → Python annotation)
 *   - snake_case identifiers for accessors/methods
 *   - TypedDict object models keyed by the EXACT apiName
 *   - client REST paths match the live routes
 *   - determinism (byte-identical across runs)
 *   - every generated .py file COMPILES under a real `python3` (syntax-valid)
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateOsdkPython,
  snakeCase,
  mapPythonType,
} from "../../../src/services/osdk/pythonGenerator";
import type { OntologySnapshot } from "../../../src/services/osdk/generator";

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
      apiName: "flight-data 2024",
      displayName: "Flight Data 2024",
      primaryKey: "flightId",
      properties: [
        { apiName: "flightId", type: "string", nullable: false },
        { apiName: "passengerCount", type: "integer", nullable: true },
        { apiName: "distanceKm", type: "double", nullable: true },
        { apiName: "delayed", type: "boolean", nullable: true },
        { apiName: "tags", type: "string_array", nullable: true },
      ],
    },
    {
      apiName: "airport",
      displayName: "Airport",
      primaryKey: "code",
      properties: [
        { apiName: "code", type: "string", nullable: false },
        { apiName: "isInternational", type: "boolean", nullable: false },
      ],
    },
  ],
  linkTypes: [
    {
      apiName: "flightToAirport",
      cardinality: "MANY_TO_ONE",
      sourceObjectType: "flight-data 2024",
      targetObjectType: "airport",
    },
  ],
  actionTypes: [
    {
      apiName: "create-flight",
      parameters: [
        { apiName: "flightId", type: "string", required: true },
        { apiName: "airport", type: "object_reference", required: true, objectType: "airport" },
      ],
    },
  ],
};

function content(path: string): string {
  const f = generateOsdkPython(fixture).find((x) => x.path === path);
  expect(f, `expected ${path}`).toBeDefined();
  return f!.content;
}

describe("python osdk — helpers", () => {
  it("snake_cases identifiers", () => {
    expect(snakeCase("isInternational")).toBe("is_international");
    expect(snakeCase("flight-data 2024")).toBe("flight_data_2024");
    expect(snakeCase("class")).toBe("class_"); // reserved → suffixed
  });

  it("maps ontology types to Python annotations", () => {
    expect(mapPythonType("string")).toBe("str");
    expect(mapPythonType("integer")).toBe("int");
    expect(mapPythonType("double")).toBe("float");
    expect(mapPythonType("boolean")).toBe("bool");
    expect(mapPythonType("string_array")).toBe("List[str]");
    expect(mapPythonType("struct")).toBe("Dict[str, Any]");
    expect(mapPythonType("geopoint")).toBe("Union[Dict[str, float], str]");
  });
});

describe("python osdk — models.py", () => {
  it("emits a TypedDict per object type keyed by exact apiName + PK alias", () => {
    const m = content("models.py");
    expect(m).toContain('FlightData2024 = TypedDict("FlightData2024", {');
    expect(m).toContain('"flightId": str,');
    expect(m).toContain('"passengerCount": int,');
    expect(m).toContain('"tags": List[str],');
    expect(m).toContain("FlightData2024PrimaryKey = str");
    expect(m).toContain('Airport = TypedDict("Airport", {');
    expect(m).toContain('"isInternational": bool,');
  });

  it("emits action-parameter TypedDicts and the LINK_TYPES table", () => {
    const m = content("models.py");
    expect(m).toContain('CreateFlightParameters = TypedDict("CreateFlightParameters", {');
    expect(m).toContain('"airport": Union[str, int],'); // object_reference
    expect(m).toContain('"flightToAirport": {"apiName": "flightToAirport"');
    expect(m).toContain('"source": "flight-data 2024", "target": "airport"');
  });
});

describe("python osdk — client.py", () => {
  it("wires snake_case object/action/link accessors", () => {
    const c = content("client.py");
    expect(c).toContain('self.flight_data_2024 = ObjectSet(core, "flight-data 2024")');
    expect(c).toContain('self.airport = ObjectSet(core, "airport")');
    expect(c).toContain("def create_flight(self, params: Dict[str, Any]) -> Any:");
    expect(c).toContain('return self._client.apply_action("create-flight", params)');
    expect(c).toContain("def flight_to_airport(self, source_primary_key");
  });

  it("uses the live REST paths", () => {
    const c = content("client.py");
    expect(c).toContain('"/v1/objects/" + ap + "/search"');
    expect(c).toContain('"/v1/objects/" + ap + "/aggregate"');
    expect(c).toContain('"/v1/objects/" + src + "/" + pk + "/links/" + link');
    expect(c).toContain('"/v1/ontology/" + urllib.parse.quote(self.ontology_id) + "/actions/"');
  });
});

describe("python osdk — determinism + syntax", () => {
  it("produces byte-identical output across runs", () => {
    const a = generateOsdkPython(fixture);
    const b = generateOsdkPython(fixture);
    expect(a.map((f) => f.content)).toEqual(b.map((f) => f.content));
  });

  it("every generated .py file compiles under python3", () => {
    let python = "python3";
    try {
      execFileSync(python, ["--version"], { stdio: "ignore" });
    } catch {
      // No python3 on this runner — skip the compile check (other assertions cover structure).
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "osdk-py-"));
    for (const f of generateOsdkPython(fixture)) {
      const p = join(dir, f.path);
      writeFileSync(p, f.content);
      // py_compile raises SyntaxError (non-zero exit) on invalid Python.
      execFileSync(python, ["-c", `import py_compile,sys; py_compile.compile(${JSON.stringify(p)}, doraise=True)`]);
    }
  });
});
