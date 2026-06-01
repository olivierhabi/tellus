// ---------------------------------------------------------------------------
// B5 — Iceberg REST catalog adapter (spec §B5 line 259).
//
// Stub: functional tests deferred until a REST catalog Testcontainer is
// configured (DEFERRED.md). Shape is stable enough for downstream code to
// switch via TELLUS_ICEBERG_ADAPTER=rest.
// ---------------------------------------------------------------------------

import type {
  CatalogAdapter,
  CatalogIdentity,
  IcebergMetadata,
  IcebergSnapshot,
} from "../index";

export class IcebergRestUnsupported extends Error {
  constructor(method: string) {
    super(
      `IcebergRestAdapter.${method}: stubbed (DEFERRED.md). Use TELLUS_ICEBERG_ADAPTER=local-fs.`,
    );
    this.name = "IcebergRestUnsupported";
  }
}

export function createRestAdapter(): CatalogAdapter {
  return {
    async ensureTable(_id: CatalogIdentity, _initial: IcebergMetadata) {
      throw new IcebergRestUnsupported("ensureTable");
    },
    async resolve(_id: CatalogIdentity) {
      throw new IcebergRestUnsupported("resolve");
    },
    async commit(_id: CatalogIdentity, _meta: IcebergMetadata) {
      throw new IcebergRestUnsupported("commit");
    },
    async listSnapshots(_id: CatalogIdentity): Promise<IcebergSnapshot[]> {
      throw new IcebergRestUnsupported("listSnapshots");
    },
  };
}
