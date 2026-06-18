// =============================================================================
// B04 — Workshop Module Bootstrap
//
// Spec §B04: "Create new" from Ontology Manager calls a bootstrap endpoint
// that allocates a fresh Workshop module document seeded with:
//   - default Header (no title)
//   - empty rootSection
//   - if seedObjectTypeApiName supplied: an Object Set variable named
//     "{DisplayName} Object Set"
//
// Composes B01 (createModule) + B06 (getObjectType for the seed). Audit row
// is emitted by B01.
//
// Spec §C Phase 5 Step 1: "Create new" → bootstrap endpoint → editor mounts
// at /workspace/workshop/{rid} → module document includes the seeded
// 'Order Object Set' variable.
// =============================================================================

import { z } from "zod";
import { createModule, type Actor, type CreatedModule } from "./moduleService.js";
import { getObjectType } from "./omsFacade.js";
import type { ModuleDefinition } from "./types.js";

export const bootstrapRequestSchema = z
  .object({
    parentFolderRid: z.string().min(1),
    ontologyRid: z.string().min(1),
    displayName: z.string().min(1).max(255),
    seedObjectTypeApiName: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .strict();

export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

interface ObjectSetVariableSeed {
  id: string;
  displayName: string;
  type: "objectSet";
  definitionType: "objectSetDefinition";
  definition: {
    kind: "ofType";
    objectTypeApiName: string;
    ontologyRid: string;
  };
}

/**
 * Build the seeded module definition. Pure; no I/O. The shape mirrors the
 * minimal valid module document that B02's validator accepts (rootSection
 * present, sections include rootSection, no widgets, optional variables).
 */
export function buildSeededDefinition(opts: {
  ontologyRid: string;
  seedObjectTypeApiName: string | null;
  seedDisplayName: string | null;
}): ModuleDefinition {
  const variables: ObjectSetVariableSeed[] = [];
  if (opts.seedObjectTypeApiName && opts.seedDisplayName) {
    variables.push({
      id: "v_seed_object_set",
      displayName: `${opts.seedDisplayName} Object Set`,
      type: "objectSet",
      definitionType: "objectSetDefinition",
      definition: {
        kind: "ofType",
        objectTypeApiName: opts.seedObjectTypeApiName,
        ontologyRid: opts.ontologyRid,
      },
    });
  }
  return {
    schemaVersion: 4,
    layout: {
      rootSection: "s_root",
    },
    sections: [
      {
        id: "s_root",
        layout: "rows",
        children: [],
      },
    ],
    widgets: [],
    variables,
  };
}

/**
 * Bootstrap a new Workshop module. Returns the fresh module row exactly as
 * B01 would, so the editor can mount the response shape with no extra fetch.
 */
export type BootstrapResult = CreatedModule;

export async function bootstrapModule(
  req: BootstrapRequest,
  actor: Actor,
  idempotencyKey: string | null,
): Promise<BootstrapResult> {
  let seedDisplayName: string | null = null;
  if (req.seedObjectTypeApiName) {
    // Resolve the display name via B06 facade; if it doesn't exist, B06
    // throws ObjectTypeNotFound which surfaces as a 404 to the caller —
    // exactly what we want.
    const ot = await getObjectType(req.ontologyRid, req.seedObjectTypeApiName);
    seedDisplayName = ot.displayName;
  }
  const definition = buildSeededDefinition({
    ontologyRid: req.ontologyRid,
    seedObjectTypeApiName: req.seedObjectTypeApiName ?? null,
    seedDisplayName,
  });

  const createReq = {
    parentFolderRid: req.parentFolderRid,
    displayName: req.displayName,
    description: req.description ?? null,
    ontologyRid: req.ontologyRid,
    definition,
  };
  const created = await createModule(createReq, actor, {
    key: idempotencyKey,
    route: "POST /api/v1/workshop/modules:bootstrap",
    body: createReq,
  });

  return {
    module: created.module,
    etag: created.etag,
    fromCache: created.fromCache,
  };
}
