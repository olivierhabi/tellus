// ---------------------------------------------------------------------------
// functionKind — declared-contract classifier.
//
// Edit-capability is derived ONLY from the declared return type
// (Edits.Object<T> imported from @osdk/functions, through single-file
// aliases and the bounded wrapper grammar). Body content is never
// inspected. Malformed/contradictory declarations throw
// InvalidEditDeclarationError — the publish pipeline turns these into
// release failures; they must never become "query" or "unknown".
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import ts from "typescript";

import {
  classifyFunctionKind,
  InvalidEditDeclarationError,
} from "../../../src/services/functionsPublish/functionKind";
import { inspectPublishedFunction } from "../../../src/services/functionsPublish/service";

const PATH = "typescript-functions/src/functions/fn.ts";

function classify(source: string): "edit" | "query" {
  const file = ts.createSourceFile(PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = file.statements.find(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s),
  );
  if (!declaration) throw new Error("test fixture has no function declaration");
  return classifyFunctionKind(file, declaration, PATH);
}

const HEADER = `
  import { Client } from "@osdk/client";
  import { Edits } from "@osdk/functions";
  import { Order } from "@ontology/sdk";
`;

describe("classifyFunctionKind — valid edit declarations", () => {
  it("direct Edits.Object<T>[] return", () => {
    expect(classify(`${HEADER}
      export default function fn(client: Client, id: string): Edits.Object<Order>[] {
        return [{ op: "update", objectType: "Order", primaryKey: id, patch: {} }];
      }
    `)).toBe("edit");
  });

  it("Array<Edits.Object<T>> return", () => {
    expect(classify(`${HEADER}
      export default function fn(client: Client): Array<Edits.Object<Order>> {
        return [];
      }
    `)).toBe("edit");
  });

  it("ReadonlyArray<Edits.Object<T>> return", () => {
    expect(classify(`${HEADER}
      export default function fn(client: Client): ReadonlyArray<Edits.Object<Order>> {
        return [];
      }
    `)).toBe("edit");
  });

  it("Promise<Edits.Object<T>[]> return", () => {
    expect(classify(`${HEADER}
      export default async function fn(client: Client): Promise<Edits.Object<Order>[]> {
        return [];
      }
    `)).toBe("edit");
  });

  it("local alias resolving to an edit return (hand-built array, no body markers)", () => {
    // The case the retired source regex misclassified: a legal edit
    // function that hand-builds its edit array with no createEditBatch
    // or Edits.* calls in the body. The DECLARATION carries the kind.
    expect(classify(`${HEADER}
      type OrderEdit = Edits.Object<Order>;
      export default function fn(client: Client, id: string): OrderEdit[] {
        return [{ op: "update", objectType: "Order", primaryKey: id, patch: { status: "closed" } } as OrderEdit];
      }
    `)).toBe("edit");
  });

  it("chained local aliases", () => {
    expect(classify(`${HEADER}
      type OrderEdit = Edits.Object<Order>;
      type OrderEditBatch = OrderEdit[];
      export default function fn(client: Client): OrderEditBatch {
        return [];
      }
    `)).toBe("edit");
  });

  it("aliased @osdk/functions import (import type { Edits as OntologyEdits })", () => {
    expect(classify(`
      import { Client } from "@osdk/client";
      import type { Edits as OntologyEdits } from "@osdk/functions";
      import { Order } from "@ontology/sdk";
      export default function fn(client: Client): OntologyEdits.Object<Order>[] {
        return [];
      }
    `)).toBe("edit");
  });
});

describe("classifyFunctionKind — query functions", () => {
  it("ordinary read-only return type", () => {
    expect(classify(`
      import { ObjectSet, ObjectSpecifier } from "@osdk/client";
      import { Order } from "@ontology/sdk";
      export default function fn(orders: ObjectSet<Order>): Record<ObjectSpecifier<Order>, string> {
        return {};
      }
    `)).toBe("query");
  });

  it("untyped-shape array return (unknown[]) with no Edits reference", () => {
    expect(classify(`
      export default function fn(id: string): unknown[] {
        return [];
      }
    `)).toBe("query");
  });

  it("createEditBatch imported but return type declares no edit contract", () => {
    // An import alone is NOT a declaration — the return type is.
    expect(classify(`
      import { createEditBatch, Objects } from "@osdk/functions";
      export default function fn(): string {
        return "read-only";
      }
    `)).toBe("query");
  });
});

describe("classifyFunctionKind — malformed/contradictory declarations throw", () => {
  it("local fake declaration named Edits (no @osdk/functions import)", () => {
    expect(() => classify(`
      type Edits = { Object<T>: unknown };
      export default function fn(): Edits.Object<string>[] {
        return [];
      }
    `)).toThrow(InvalidEditDeclarationError);
  });

  it("Edits return type with the import missing entirely", () => {
    expect(() => classify(`
      export default function fn(): Edits.Object<string>[] {
        return [];
      }
    `)).toThrow(/not imported/);
  });

  it("circular alias chain", () => {
    expect(() => classify(`${HEADER}
      type A = B[];
      type B = A;
      export default function fn(): A {
        return [];
      }
    `)).toThrow(/circular/);
  });

  it("ambiguous union of edit and non-edit outputs", () => {
    expect(() => classify(`${HEADER}
      export default function fn(): Edits.Object<Order>[] | string {
        return [];
      }
    `)).toThrow(/ambiguous union/);
  });

  it("unsupported wrapper around an edit type (Map)", () => {
    expect(() => classify(`${HEADER}
      export default function fn(): Map<string, Edits.Object<Order>> {
        return new Map();
      }
    `)).toThrow(/unsupported/);
  });

  it("bare Edits reference (not Edits.Object<T>)", () => {
    expect(() => classify(`${HEADER}
      export default function fn(): Edits {
        throw new Error("x");
      }
    `)).toThrow(/unsupported edit type form/);
  });
});

describe("inspectPublishedFunction — one shared analysis (signature + kind)", () => {
  it("returns signature and kind from a single walk", () => {
    const metadata = inspectPublishedFunction(PATH.replace("fn.ts", "closeOrder.ts"), `${HEADER}
      type OrderEdit = Edits.Object<Order>;
      export default function closeOrder(client: Client, orderId: string): OrderEdit[] {
        return [];
      }
    `);
    expect(metadata.functionKind).toBe("edit");
    expect(metadata.signature).toEqual({
      parameters: [
        {
          name: "client",
          type: "Client",
          optional: false,
          position: 0,
          hasDefault: false,
          typeModel: { kind: "client" },
        },
        {
          name: "orderId",
          type: "string",
          optional: false,
          position: 1,
          hasDefault: false,
          typeModel: { kind: "string" },
        },
      ],
      output: "OrderEdit[]",
    });
  });

  it("fails publication for a malformed edit declaration (INVALID_FUNCTION)", () => {
    expect(() => inspectPublishedFunction(PATH.replace("fn.ts", "fake.ts"), `
      export default function fake(): Edits.Object<string>[] {
        return [];
      }
    `)).toThrow(/not imported/);
  });
});
