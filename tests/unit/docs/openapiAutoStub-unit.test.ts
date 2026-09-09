// ---------------------------------------------------------------------------
// openapiAutoStub — extracted from docs/openapi.ts during the god-file
// breakup. Pins the served-spec stub semantics directly against the
// standalone module.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  areaTag,
  autoStub,
  isPublicPath,
  normShape,
  pathParameters,
} from "../../../src/docs/openapiAutoStub";

describe("normShape", () => {
  it("collapses {param} and :param segments to {}", () => {
    expect(normShape("/api/v1/ontology/{ontologyId}/objects/{id}")).toBe(
      "/api/v1/ontology/{}/objects/{}",
    );
    expect(normShape("/api/v1/objects/:id/links/:link")).toBe("/api/v1/objects/{}/links/{}");
    expect(normShape("/health")).toBe("/health");
  });
});

describe("areaTag", () => {
  it("maps well-known prefixes", () => {
    expect(areaTag("/health")).toBe("Health");
    expect(areaTag("/healthz/deep")).toBe("Health");
    expect(areaTag("/api/docs")).toBe("Meta");
    expect(areaTag("/api/metrics")).toBe("Meta");
    expect(areaTag("/quiver/boards")).toBe("Quiver");
    expect(areaTag("/api/v1/ontology/types")).toBe("Ontology");
    expect(areaTag("/api/v1/code-repositories/publish")).toBe("Code Repositories");
    expect(areaTag("/api/v1/compass/search")).toBe("Foundry");
  });

  it("capitalises unknown areas", () => {
    expect(areaTag("/api/v1/something/else")).toBe("Something");
  });
});

describe("pathParameters", () => {
  it("synthesises required string params", () => {
    expect(pathParameters("/api/v1/ontology/{ontologyId}/objects/{id}")).toEqual([
      { name: "ontologyId", in: "path", required: true, schema: { type: "string" }, description: "ontologyId path parameter" },
      { name: "id", in: "path", required: true, schema: { type: "string" }, description: "id path parameter" },
    ]);
    expect(pathParameters("/health")).toEqual([]);
  });
});

describe("isPublicPath", () => {
  it("marks health/docs/auth entry points public", () => {
    expect(isPublicPath("/health")).toBe(true);
    expect(isPublicPath("/api/docs/spec.json")).toBe(true);
    expect(isPublicPath("/api/metrics")).toBe(true);
    expect(isPublicPath("/api/v1/auth/login")).toBe(true);
    expect(isPublicPath("/api/v1/auth/refresh")).toBe(true);
  });

  it("keeps the data plane private", () => {
    expect(isPublicPath("/api/v1/ontology/types")).toBe(false);
    expect(isPublicPath("/api/v1/auth/me")).toBe(false);
  });
});

describe("autoStub", () => {
  it("tags, documents and secures a private route", () => {
    const op = autoStub("GET", "/api/v1/ontology/{ontologyId}/objects");
    expect(op.tags).toEqual(["Ontology"]);
    expect(op.summary).toBe("GET /api/v1/ontology/{ontologyId}/objects");
    expect(op["x-auto-generated"]).toBe(true);
    expect(op.security).toEqual([{ bearerAuth: [] }]);
    expect(op.requestBody).toBeUndefined();
    expect(Object.keys(op.responses as Record<string, unknown>).sort()).toEqual(
      ["200", "400", "401", "403", "404", "500"],
    );
  });

  it("adds a generic JSON body for write methods and no auth for public paths", () => {
    const post = autoStub("POST", "/api/v1/auth/login") as {
      requestBody: { content: { "application/json": unknown } };
      security: unknown[];
    };
    expect(post.requestBody.content["application/json"]).toBeDefined();
    expect(post.security).toEqual([]);
  });
});
