/**
 * Persisted dataset formats shared by foundry_datasets and ontology bindings.
 * Migration 179 pins both database CHECK constraints to this same value set;
 * the contract regression test prevents either side from drifting.
 */
export const DATASET_FORMATS = [
  "csv",
  "json",
  "parquet",
  "iceberg",
  "stream",
] as const;

export type DatasetFormat = (typeof DATASET_FORMATS)[number];

export function isDatasetFormat(value: unknown): value is DatasetFormat {
  return typeof value === "string" &&
    (DATASET_FORMATS as readonly string[]).includes(value.toLowerCase());
}

