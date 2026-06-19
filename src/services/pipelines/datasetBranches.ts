// ---------------------------------------------------------------------------
// FOUNDRY-GAPS §6 — dataset branches & tags over Iceberg refs.
//
// Foundry's "dataset branches" analog: dev/prod isolation for an Iceberg-
// backed `foundry_datasets` row via Iceberg snapshot refs (branches & tags).
// Refs live entirely in the Iceberg table metadata — there is no Postgres
// schema involvement — so this service is a thin validation + location-
// resolution layer over the PyIceberg sidecar bridge.
//
// Location conventions (recorded on foundry_datasets.file_path /
// iceberg_location, parsed by computeEngine.parseIcebergLocation):
//   `<warehouse>:<namespace>.<table>`            (Funnel convention)
//   `<warehouse>/<namespace>/<table>#snapshot=N` (pipeline deploy convention)
// ---------------------------------------------------------------------------

import { AppError } from "../../utils/foundryAppError";
import { parseIcebergLocation } from "./computeEngine";
import {
  icebergCreateBranch,
  icebergCreateTag,
  icebergDropRef,
  icebergFastForward,
  icebergListRefs,
  type CreateRefResult,
  type DropRefResult,
  type FastForwardResult,
  type IcebergRefRow,
} from "./icebergSidecar";

/** The slice of a foundry_datasets row this service needs. */
export interface DatasetRowLike {
  id: string;
  format?: string | null;
  file_path?: string | null;
  iceberg_location?: string | null;
}

export interface IcebergTarget {
  warehouse: string;
  namespace: string;
  table: string;
  snapshotId: string | null;
}

// Iceberg ref names follow the Git-ish convention Foundry uses for dataset
// branches: must start with a letter or digit; letters, digits, `.`, `_`,
// `-` afterwards; max 255 chars. `main` is the protected default branch.
const REF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
export const MAIN_BRANCH = "main";

/**
 * Resolve the Iceberg (warehouse, namespace, table) coordinates for a
 * foundry_datasets row. Throws DATASET_NOT_ICEBERG when the row is not an
 * Iceberg dataset or its recorded location does not parse as one.
 */
export function resolveIcebergTarget(dataset: DatasetRowLike): IcebergTarget {
  if ((dataset.format ?? "").toLowerCase() !== "iceberg") {
    throw new AppError(
      `Dataset ${dataset.id} is not Iceberg-backed (format=${dataset.format ?? "unknown"}); branches and tags require format='iceberg'.`,
      400,
      "DATASET_NOT_ICEBERG",
    );
  }
  const raw = dataset.iceberg_location ?? dataset.file_path ?? "";
  const parsed = raw ? parseIcebergLocation(raw) : null;
  if (!parsed) {
    throw new AppError(
      `Dataset ${dataset.id} has format='iceberg' but its location "${raw}" is not a recognised Iceberg table location.`,
      400,
      "DATASET_NOT_ICEBERG",
    );
  }
  return parsed;
}

function assertRefName(name: unknown, opts: { allowMain?: boolean } = {}): string {
  if (typeof name !== "string" || !REF_NAME_RE.test(name)) {
    throw new AppError(
      `Invalid ref name "${String(name)}". Ref names must match ${REF_NAME_RE} (letters, digits, '.', '_', '-'; max 255 chars).`,
      400,
      "REF_NAME_INVALID",
    );
  }
  if (!opts.allowMain && name === MAIN_BRANCH) {
    throw new AppError(
      `"${MAIN_BRANCH}" is the protected default branch and cannot be created or dropped.`,
      400,
      "REF_NAME_INVALID",
    );
  }
  return name;
}

/**
 * Map raw sidecar failures onto typed AppErrors. The sidecar surfaces
 * Python-side exceptions as plain Errors with the original message; the
 * "already exists" / "not found" strings come from both our own actions and
 * pyiceberg/catalog CommitFailedExceptions, so REF_EXISTS passes through
 * even when the conflict is detected at commit time (OCC race).
 */
function rethrowSidecarError(err: unknown): never {
  if (err instanceof AppError) throw err;
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("already exist")) {
    throw new AppError(msg, 409, "REF_EXISTS");
  }
  if (lower.includes("ref not found") || lower.includes("does not exist")) {
    throw new AppError(msg, 404, "REF_NOT_FOUND");
  }
  if (lower.includes("cannot fast-forward") || lower.includes("not an ancestor")) {
    throw new AppError(msg, 409, "REF_NOT_FAST_FORWARD");
  }
  if (lower.includes("is not a branch")) {
    throw new AppError(msg, 400, "REF_NAME_INVALID");
  }
  if (lower.includes("no snapshots")) {
    throw new AppError(msg, 409, "DATASET_EMPTY");
  }
  throw new AppError(msg, 500, "ICEBERG_SIDECAR_ERROR");
}

export async function listRefs(dataset: DatasetRowLike): Promise<IcebergRefRow[]> {
  const target = resolveIcebergTarget(dataset);
  try {
    const res = await icebergListRefs({
      warehouse: target.warehouse,
      namespace: target.namespace,
      table: target.table,
    });
    return res.refs;
  } catch (err) {
    rethrowSidecarError(err);
  }
}

export async function createBranch(
  dataset: DatasetRowLike,
  branchName: string,
  fromSnapshotId?: number | string,
): Promise<CreateRefResult> {
  const target = resolveIcebergTarget(dataset);
  assertRefName(branchName);
  try {
    return await icebergCreateBranch({
      warehouse: target.warehouse,
      namespace: target.namespace,
      table: target.table,
      refName: branchName,
      snapshotId: fromSnapshotId,
    });
  } catch (err) {
    rethrowSidecarError(err);
  }
}

export async function createTag(
  dataset: DatasetRowLike,
  tagName: string,
  fromSnapshotId?: number | string,
): Promise<CreateRefResult> {
  const target = resolveIcebergTarget(dataset);
  assertRefName(tagName);
  try {
    return await icebergCreateTag({
      warehouse: target.warehouse,
      namespace: target.namespace,
      table: target.table,
      refName: tagName,
      snapshotId: fromSnapshotId,
    });
  } catch (err) {
    rethrowSidecarError(err);
  }
}

export async function dropRef(
  dataset: DatasetRowLike,
  refName: string,
): Promise<DropRefResult> {
  const target = resolveIcebergTarget(dataset);
  assertRefName(refName);
  try {
    return await icebergDropRef({
      warehouse: target.warehouse,
      namespace: target.namespace,
      table: target.table,
      refName,
    });
  } catch (err) {
    rethrowSidecarError(err);
  }
}

export async function fastForward(
  dataset: DatasetRowLike,
  branchName: string,
  toRef: string,
): Promise<FastForwardResult> {
  const target = resolveIcebergTarget(dataset);
  // Fast-forwarding `main` to a dev branch IS the promote path, so main is
  // allowed as the branch being moved; the target ref just has to be valid.
  assertRefName(branchName, { allowMain: true });
  assertRefName(toRef, { allowMain: true });
  try {
    return await icebergFastForward({
      warehouse: target.warehouse,
      namespace: target.namespace,
      table: target.table,
      branchName,
      toRef,
    });
  } catch (err) {
    rethrowSidecarError(err);
  }
}
