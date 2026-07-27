-- ===========================================================================
-- 120_transform_build_runtime.sql
--
-- Track 1 (Python transform lightweight runtime): records the execution
-- model on each transform_build row. The existing `transforms-python`
-- pipeline ran every @transform / @transform_df / @transform_pandas through
-- the PySpark-backed transforms.api shim (pythonRuntime.ts → _get_spark),
-- i.e. every historical build was Spark-backed. The new `@lightweight`
-- decorator (3.0.0 manifest) runs WITHOUT a SparkSession — single-process,
-- pandas-only — and is recorded as runtime='lightweight'.
--
-- The runtime is selected by buildService from the discovered transform's
-- kind at scheduling time (runtimeFor(kind) in discovery.ts):
--   kind === 'lightweight' -> 'lightweight'
--   kind in ('transform','transform_df','transform_pandas') -> 'spark'
--
-- The column is `lightweight` by default AND all pre-existing rows are
-- backfilled to `spark`, since they all ran against the PySpark shim — a
-- future read of a historical build (`runtime`) must not mislabel a
-- Spark-backed build as 'lightweight'.
-- ===========================================================================

ALTER TABLE transform_build
  ADD COLUMN IF NOT EXISTS runtime TEXT NOT NULL DEFAULT 'lightweight'
    CHECK (runtime IN ('lightweight', 'spark'));

-- Backfill historical builds: the existing kinds were all Spark-backed.
UPDATE transform_build SET runtime = 'spark' WHERE runtime = 'lightweight';
