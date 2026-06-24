// Unit tests for the Workshop error envelope.
//
// Contract IDs covered:
//   - G-01 (Conjure-style envelope shape)
//   - B01 C-07/C-08 (ModuleNotFound), C-09/C-10 (ResourceVersionMismatch),
//     C-06 (ModuleNameConflict), C-05 (ModuleTooLarge),
//     C-15/C-16 (Idempotency)

import { describe, it, expect } from "vitest";
import {
  ERROR_CODES,
  STATUS_BY_CODE,
  WorkshopError,
  idempotencyKeyReused,
  invalidModuleSchema,
  moduleNameConflict,
  moduleNotFound,
  moduleTooLarge,
  ontologyNotFound,
  parentFolderNotFound,
  resourceVersionMismatch,
} from "../../../src/services/workshop/errors";

describe("G-01: WorkshopError envelope", () => {
  it("G-01: envelope shape has the required fields", () => {
    const e = moduleNotFound("ri.workshop.main.module.deadbeef");
    const env = e.toEnvelope();
    expect(env).toHaveProperty("errorCode");
    expect(env).toHaveProperty("errorName");
    expect(env).toHaveProperty("errorInstanceId");
    expect(env).toHaveProperty("parameters");
  });

  it("G-01: errorInstanceId is a UUID v4", () => {
    const e = moduleNotFound("rid");
    expect(e.errorInstanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("G-01: errorName is in Tellus:<Service>:<PascalCase> form", () => {
    const e = moduleNotFound("rid");
    expect(e.errorName).toMatch(/^Tellus:[A-Z][A-Za-z0-9]+:[A-Z][A-Za-z0-9]+$/);
  });

  it("G-01: invalid errorName fails fast at construction", () => {
    expect(
      () =>
        new WorkshopError(
          "INVALID_ARGUMENT",
          "tellus:workshop:lowercase" as never,
        ),
    ).toThrow();
    expect(
      () =>
        new WorkshopError("INVALID_ARGUMENT", "Tellus:workshop:NoServicePCase"),
    ).toThrow();
  });

  it("G-01: every ERROR_CODE has a status mapping", () => {
    for (const code of ERROR_CODES) {
      expect(STATUS_BY_CODE[code]).toBeGreaterThanOrEqual(400);
      expect(STATUS_BY_CODE[code]).toBeLessThan(600);
    }
  });

  it("G-01: status mapping matches §0.1", () => {
    expect(STATUS_BY_CODE.INVALID_ARGUMENT).toBe(400);
    expect(STATUS_BY_CODE.NOT_FOUND).toBe(404);
    expect(STATUS_BY_CODE.CONFLICT).toBe(409);
    expect(STATUS_BY_CODE.PERMISSION_DENIED).toBe(403);
    expect(STATUS_BY_CODE.FAILED_PRECONDITION).toBe(412);
    expect(STATUS_BY_CODE.REQUEST_ENTITY_TOO_LARGE).toBe(413);
    expect(STATUS_BY_CODE.INTERNAL).toBe(500);
    expect(STATUS_BY_CODE.TIMEOUT).toBe(504);
  });
});

describe("B01: domain-specific error constructors", () => {
  it("B01 C-07/C-08: moduleNotFound returns 404 with rid in parameters", () => {
    const e = moduleNotFound("ri.workshop.main.module.x");
    expect(e.errorName).toBe("Tellus:Workshop:ModuleNotFound");
    expect(e.httpStatus).toBe(404);
    expect(e.parameters.rid).toBe("ri.workshop.main.module.x");
  });

  it("B01 C-09/C-10: resourceVersionMismatch returns 412 with currentEtag", () => {
    const e = resourceVersionMismatch("rid-x", 'W/"deadbeef"');
    expect(e.errorName).toBe("Tellus:Workshop:ResourceVersionMismatch");
    expect(e.httpStatus).toBe(412);
    expect(e.parameters.currentEtag).toBe('W/"deadbeef"');
  });

  it("B01 C-06: moduleNameConflict returns 409", () => {
    const e = moduleNameConflict(
      "ri.compass.main.folder.f",
      "Olivier Orders Inbox",
    );
    expect(e.errorName).toBe("Tellus:Workshop:ModuleNameConflict");
    expect(e.httpStatus).toBe(409);
  });

  it("B01 C-05: moduleTooLarge returns 413 with size and limit", () => {
    const e = moduleTooLarge(3 * 1024 * 1024);
    expect(e.errorName).toBe("Tellus:Workshop:ModuleTooLarge");
    expect(e.httpStatus).toBe(413);
    expect(e.parameters.sizeBytes).toBe(3 * 1024 * 1024);
    expect(e.parameters.limitBytes).toBe(2 * 1024 * 1024);
  });

  it("B01 C-15/C-16: idempotencyKeyReused returns 409", () => {
    const e = idempotencyKeyReused("00000000-0000-4000-8000-000000000000");
    expect(e.errorName).toBe("Tellus:Workshop:IdempotencyKeyReused");
    expect(e.httpStatus).toBe(409);
  });

  it("B01 C-17: ontologyNotFound returns 400", () => {
    const e = ontologyNotFound("ri.ontology.main.ontology.x");
    expect(e.errorName).toBe("Tellus:Workshop:OntologyNotFound");
    expect(e.httpStatus).toBe(400);
  });

  it("B01 C-18: parentFolderNotFound returns 400", () => {
    const e = parentFolderNotFound("ri.compass.main.folder.x");
    expect(e.errorName).toBe("Tellus:Workshop:ParentFolderNotFound");
    expect(e.httpStatus).toBe(400);
  });

  it("B01 C-03..C-05: invalidModuleSchema returns 400 with reason", () => {
    const e = invalidModuleSchema("displayName too long", { length: 250 });
    expect(e.errorName).toBe("Tellus:Workshop:InvalidModuleSchema");
    expect(e.httpStatus).toBe(400);
    expect(e.parameters.reason).toBe("displayName too long");
    expect(e.parameters.length).toBe(250);
  });
});
