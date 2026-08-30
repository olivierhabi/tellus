import { describe, expect, it } from "vitest";
import { normalizeVegaChartAgentResult } from "../../../src/services/aiEngine/vegaChart";

describe("normalizeVegaChartAgentResult", () => {
  it("preserves a core Vega labelled-donut dataflow", () => {
    const normalized = normalizeVegaChartAgentResult(
      {
        response: {
          $schema: "https://vega.github.io/schema/vega/v6.json",
          data: [
            {
              name: "status",
              values: [{ status: "must-not-be-inlined" }],
            },
            {
              name: "table",
              source: "status",
              transform: [{ type: "pie", field: "value" }],
            },
            {
              name: "labelPositionsFinal",
              source: "table",
              transform: [{ type: "formula", as: "labelPath", expr: "''" }],
            },
          ],
          marks: [
            { type: "arc", from: { data: "table" } },
            { type: "path", from: { data: "labelPositionsFinal" } },
          ],
        },
      },
      "status",
    );

    const spec = JSON.parse(normalized.spec) as {
      data: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(spec.data)).toBe(true);
    expect(spec.data.map(({ name }) => name)).toEqual([
      "status",
      "table",
      "labelPositionsFinal",
    ]);
    expect(spec.data[0]).toEqual({ name: "status" });
    expect(spec.data[1]).toMatchObject({ source: "status" });
  });

  it("continues enforcing the Vega-Lite named-data contract", () => {
    const normalized = normalizeVegaChartAgentResult(
      {
        response: {
          $schema: "https://vega.github.io/schema/vega-lite/v6.json",
          data: { name: "wrong", values: [{ value: 1 }], url: "https://example.test" },
          mark: "bar",
        },
      },
      "orders",
    );

    expect(JSON.parse(normalized.spec).data).toEqual({ name: "orders" });
  });
});
