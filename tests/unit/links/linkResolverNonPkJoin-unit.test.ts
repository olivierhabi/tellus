import { beforeEach, describe, expect, it, vi } from "vitest";

const searchSpy = vi.fn();
const getSpy = vi.fn();

vi.mock("../../../src/services/opensearch/client", async () => {
  const actual = await vi.importActual<typeof import("../../../src/services/opensearch/client")>(
    "../../../src/services/opensearch/client",
  );
  return {
    ...actual,
    client: {
      search: (...args: any[]) => searchSpy(...args),
      count: vi.fn(),
      get: (...args: any[]) => getSpy(...args),
      indices: { exists: vi.fn() },
    },
  };
});

vi.mock("../../../src/db", () => ({
  query: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("FROM object_type")) {
      return { rows: [{ api_name: params[0] === "ot-source" ? "WorkflowViolation" : "OperationalException" }] };
    }
    if (sql.includes("FROM property")) {
      const apiName = params[0] === "prop-source-app" ? "applicationId" : "applicationId";
      return { rows: [{ api_name: apiName }] };
    }
    return { rows: [] };
  }),
  withTransaction: vi.fn(),
}));

import { resolveLinks, searchAround } from "../../../src/services/linkResolverService";

const linkType = {
  link_type_id: "lt-recovery",
  api_name: "iremboV6ViolationOperationalExceptions",
  display_name: "Workflow violation has operational exceptions",
  source_object_type: "ot-source",
  target_object_type: "ot-target",
  source_property_id: "prop-source-app",
  target_property_id: "prop-target-app",
  cardinality: "ONE_TO_MANY",
  join_table_file_path: null,
  ontology_id: "ont-1",
  direction: "forward",
  mcp_propagation_mode: "union",
  mcp_required_count: 1,
  mandatory_control_property_id: null,
} as any;

describe("ONE_TO_MANY non-primary-key joins", () => {
  beforeEach(() => {
    searchSpy.mockReset();
    getSpy.mockReset();
  });

  it("reverse traversal resolves the source by its configured property, not __pk", async () => {
    getSpy.mockResolvedValue({
      statusCode: 200,
      body: {
        _source: {
          __pk: "EXC:APP-WS-0037:MISSING_ATTACHMENT",
          applicationId: "APP-WS-0037",
        },
      },
    });
    searchSpy.mockResolvedValue({
      statusCode: 200,
      body: {
        hits: {
          total: { value: 1 },
          hits: [{ _source: { __pk: "WV-0037", applicationId: "APP-WS-0037" } }],
        },
      },
    });

    const result = await resolveLinks(
      linkType,
      "EXC:APP-WS-0037:MISSING_ATTACHMENT",
      "reverse",
      {},
      null,
      null,
    );

    expect(result.totalCount).toBe(1);
    expect(result.linkedObjects[0]?.__pk).toBe("WV-0037");
    const searchBody = searchSpy.mock.calls[0][0].body as Record<string, any>;
    expect(searchBody.query).toEqual({
      bool: {
        minimum_should_match: 1,
        should: [
          { term: { "applicationId.keyword": "APP-WS-0037" } },
          { match_phrase: { applicationId: "APP-WS-0037" } },
        ],
      },
    });
  });

  it("forward traversal reads the configured source property before matching targets", async () => {
    getSpy.mockResolvedValue({
      statusCode: 200,
      body: { _source: { __pk: "WV-0037", applicationId: "APP-WS-0037" } },
    });
    searchSpy.mockResolvedValue({
      statusCode: 200,
      body: {
        hits: {
          total: { value: 1 },
          hits: [{ _source: { __pk: "EXC:APP-WS-0037:MISSING_ATTACHMENT", applicationId: "APP-WS-0037" } }],
        },
      },
    });

    const result = await resolveLinks(linkType, "WV-0037", "forward", {}, null, null);

    expect(result.totalCount).toBe(1);
    const searchBody = searchSpy.mock.calls[0][0].body as Record<string, any>;
    expect(searchBody.query).toEqual({
      bool: {
        minimum_should_match: 1,
        should: [
          { term: { "applicationId.keyword": "APP-WS-0037" } },
          { match_phrase: { applicationId: "APP-WS-0037" } },
        ],
      },
    });
  });

  it("searchAround fast path uses the configured source join property instead of source PKs", async () => {
    searchSpy
      .mockResolvedValueOnce({
        statusCode: 200,
        body: {
          hits: {
            total: { value: 1 },
            hits: [{ _source: { __pk: "WV-0037", applicationId: "APP-WS-0037" } }],
          },
        },
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        body: {
          hits: {
            total: { value: 1 },
            hits: [{ _source: { __pk: "EXC:APP-WS-0037:MISSING_ATTACHMENT", applicationId: "APP-WS-0037" } }],
          },
        },
      });

    const result = await searchAround(
      linkType,
      "forward",
      { sourceFilter: { __pk: "WV-0037" }, pageSize: 10 },
      null,
      null,
    );

    expect(result.totalCount).toBe(1);
    expect(result.linkedObjects[0]?.__pk).toBe("EXC:APP-WS-0037:MISSING_ATTACHMENT");
    const sourceBody = searchSpy.mock.calls[0][0].body as Record<string, any>;
    expect(sourceBody._source).toEqual(["__pk", "applicationId"]);
    const targetBody = searchSpy.mock.calls[1][0].body as Record<string, any>;
    expect(JSON.stringify(targetBody.query)).toContain("APP-WS-0037");
    expect(JSON.stringify(targetBody.query)).not.toContain("WV-0037");
  });
});
