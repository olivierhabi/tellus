import { AppError } from '../../utils/foundryAppError';

/**
 * Foundry parity — Pipeline Builder output WRITE MODES
 * (pipeline-builder/outputs-add-dataset-output) and incremental
 * replay semantics (building-pipelines/create-incremental-pipeline-pb):
 *
 *   **Default:** "output the result as an `APPEND` transaction if at
 *   least one input is marked as incremental and all inputs that are
 *   marked as incremental have only had `APPEND` or additive `UPDATE`
 *   transactions since the previous build. Otherwise ... a `SNAPSHOT`
 *   transaction."
 *   **Snapshot replace:** "a `SNAPSHOT` transaction where the new data is
 *   merged with the previous output. Existing primary keys in the
 *   previous output will be dropped in favor of the new rows."
 *   **Snapshot replace and remove:** "a `SNAPSHOT` transaction where the
 *   new data is merged with the previous output followed by a
 *   post-filtering stage to remove rows from previous transactions based
 *   on a provided boolean `post_filtering_column`."
 *   **Changelog:** "a series of `APPEND` transactions that contain the
 *   complete history of changes to all records."
 *   **Append only new rows:** "an `APPEND` transaction where only new
 *   rows, defined as newly seen primary keys, are added to the output."
 *   **Snapshot only new rows:** "a `SNAPSHOT` transaction where only rows
 *   with newly seen primary keys are kept in the output."
 *   **Always append rows:** "an `APPEND` transaction."
 *
 *   Replay: "Replaying on deploy will produce a `SNAPSHOT` transaction on
 *   the output dataset."
 *
 * Our read model serves the dataset's LATEST VIEW from the newest
 * committed transaction's file; therefore every mode below materialises
 * the full current view (previous view merged with the new build's rows),
 * and the APPEND flag only marks the transaction TYPE — the row count of
 * the file itself is always the full view.
 */

export type WriteMode =
  | 'default'
  | 'snapshot_replace'
  | 'snapshot_replace_and_remove'
  | 'changelog'
  | 'append_only_new'
  | 'snapshot_only_new'
  | 'always_append';

export const WRITE_MODES: readonly WriteMode[] = [
  'default',
  'snapshot_replace',
  'snapshot_replace_and_remove',
  'changelog',
  'append_only_new',
  'snapshot_only_new',
  'always_append',
];

export interface WriteModeConfig {
  writeMode?: string | null;
  primaryKey?: string | null;
  postFilteringColumn?: string | null;
}

export interface WriteModeApplication {
  /** The full current view to materialise. */
  rows: Array<Record<string, unknown>>;
  /** Foundry transaction type committed for this build. */
  transactionType: 'SNAPSHOT' | 'APPEND';
  /** How many of `newRows` were NOT already present by primary key. */
  appendedRowCount: number;
}

const PK_REQUIRED: ReadonlyArray<WriteMode> = [
  'snapshot_replace',
  'snapshot_replace_and_remove',
  'changelog',
  'append_only_new',
  'snapshot_only_new',
];

/** Validate the output node's write-mode config at deploy start. */
export function validateWriteModeConfig(cfg: WriteModeConfig): WriteMode {
  const mode = (cfg.writeMode ?? 'default') as WriteMode;
  if (!WRITE_MODES.includes(mode)) {
    throw new AppError(
      `Unknown write mode "${cfg.writeMode}". Valid modes: ${WRITE_MODES.join(', ')}.`,
      400,
      'VALIDATION_ERROR',
    );
  }
  const pk = (cfg.primaryKey ?? '').trim() || null;
  if (PK_REQUIRED.includes(mode) && !pk) {
    // Foundry disables these write modes without a primary key; we fail
    // the build with the equivalent validation error.
    throw new AppError(
      `Write mode "${mode}" requires a primary key (config.primaryKey).`,
      400,
      'PRIMARY_KEY_REQUIRED',
      true,
      { writeMode: mode },
      'PrimaryKeyRequired',
    );
  }
  if (mode === 'snapshot_replace_and_remove' && !(cfg.postFilteringColumn ?? '').trim()) {
    throw new AppError(
      'Write mode "snapshot_replace_and_remove" requires config.postFilteringColumn.',
      400,
      'POST_FILTERING_COLUMN_REQUIRED',
      true,
      { writeMode: mode },
      'PostFilteringColumnRequired',
    );
  }
  return mode;
}

function dedupeKeepLast(rows: Array<Record<string, unknown>>, pk: string) {
  const seen = new Map<unknown, number>();
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const key = row[pk];
    if (key === undefined || key === null) {
      out.push(row); // no pk value — treated as always-new
      continue;
    }
    if (seen.has(key)) {
      // Doc: "If duplicate rows exist within the current transaction,
      // all but one are dropped at random" — we keep the LAST
      // deterministically.
      out[seen.get(key)!] = row;
    } else {
      seen.set(key, out.length);
      out.push(row);
    }
  }
  return out;
}

export function applyWriteMode(args: {
  config: WriteModeConfig;
  prevRows: Array<Record<string, unknown>>;
  newRows: Array<Record<string, unknown>>;
  /**
   * true when every input is marked incremental AND all incremental
   * inputs saw only APPEND/additive UPDATEs since the previous build —
   * the documented precondition for the default mode to emit APPEND.
   */
  incrementalAppendEligible?: boolean;
  /** Replay on deploy — always a full-compute SNAPSHOT. */
  replay?: boolean;
}): WriteModeApplication {
  const { config, prevRows, newRows, replay } = args;
  const mode = validateWriteModeConfig(config);
  const pk = (config.primaryKey ?? '').trim() || null;

  // Replay on deploy → SNAPSHOT transaction, recomputed over the entire
  // input. No previous-state merge.
  if (replay) {
    return { rows: newRows, transactionType: 'SNAPSHOT', appendedRowCount: newRows.length };
  }

  switch (mode) {
    case 'default': {
      if (args.incrementalAppendEligible && prevRows.length > 0) {
        return {
          rows: [...prevRows, ...newRows],
          transactionType: 'APPEND',
          appendedRowCount: newRows.length,
        };
      }
      return { rows: newRows, transactionType: 'SNAPSHOT', appendedRowCount: newRows.length };
    }

    case 'always_append': {
      return {
        rows: [...prevRows, ...newRows],
        transactionType: 'APPEND',
        appendedRowCount: newRows.length,
      };
    }

    case 'changelog': {
      // "A series of APPEND transactions that contain the complete
      // history of changes to all records" — nothing is deduplicated or
      // merged.
      return {
        rows: [...prevRows, ...newRows],
        transactionType: 'APPEND',
        appendedRowCount: newRows.length,
      };
    }

    case 'append_only_new': {
      const prevKeys = new Set<unknown>(
        prevRows.map((r) => r[pk as string]).filter((k) => k != null),
      );
      const candidates = dedupeKeepLast(newRows, pk as string);
      const appended = candidates.filter((r) => r[pk as string] == null || !prevKeys.has(r[pk as string]));
      return {
        rows: [...prevRows, ...appended],
        transactionType: 'APPEND',
        appendedRowCount: appended.length,
      };
    }

    case 'snapshot_replace': {
      const byKey = new Map<unknown, Record<string, unknown>>();
      const order: unknown[] = [];
      const extras: Array<Record<string, unknown>> = [];
      for (const row of prevRows) {
        const key = row[pk as string];
        if (key == null) extras.push(row);
        else if (!byKey.has(key)) {
          byKey.set(key, row);
          order.push(key);
        }
      }
      for (const row of dedupeKeepLast(newRows, pk as string)) {
        const key = row[pk as string];
        if (key == null) extras.push(row);
        else {
          if (!byKey.has(key)) order.push(key);
          byKey.set(key, row);
        }
      }
      return {
        rows: [...order.map((k) => byKey.get(k)!), ...extras],
        transactionType: 'SNAPSHOT',
        appendedRowCount: [...newRows.map((r) => r[pk as string])].filter(
          (k) => k != null && ![...prevRows.map((r) => r[pk as string])].includes(k),
        ).length,
      };
    }

    case 'snapshot_replace_and_remove': {
      const replaced = applyWriteMode({
        config: { writeMode: 'snapshot_replace', primaryKey: pk },
        prevRows,
        newRows,
      });
      const expr = config.postFilteringColumn!.trim();
      const rows = replaced.rows.filter((r) => !truthy(r[expr]));
      return {
        rows,
        transactionType: 'SNAPSHOT',
        appendedRowCount: replaced.appendedRowCount,
      };
    }

    case 'snapshot_only_new': {
      const prevKeys = new Set<unknown>(
        prevRows.map((r) => r[pk as string]).filter((k) => k != null),
      );
      const kept = newRows.filter((r) => r[pk as string] != null && !prevKeys.has(r[pk as string]));
      return { rows: kept, transactionType: 'SNAPSHOT', appendedRowCount: kept.length };
    }
  }
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true' || v === 'TRUE' || v === 1 || v === '1';
}
