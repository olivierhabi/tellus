// ===========================================================================
// Python runtime assets for the transform build engine.
//
// These are emitted to a per-build temp workdir by executor.ts and executed
// with the configured Python (TELLUS_PYTHON_BIN; a venv with pyspark + pandas
// + pyarrow, and JAVA_HOME on the child env). They are embedded as string
// constants (rather than shipped as .py files) so they are available
// identically under tsx (dev/test) and a compiled dist/ build with no
// asset-copy step.
//
//   transforms/api.py  — a subset of Foundry's transforms-python API backed by
//                        a local-mode SparkSession: Input.dataframe() returns a
//                        pyspark.sql.DataFrame; Input.pandas() returns a
//                        pandas.DataFrame (read directly, skipping Spark);
//                        Output.write_dataframe accepts pyspark/pandas/stdlib
//                        DataFrames; Output.set_mode + a Context (ctx,
//                        is_incremental) for @incremental; a stdlib DataFrame
//                        is retained for in-memory construction.
//   driver.py          — binds one @transform to real dataset files, injects
//                        ctx per Foundry's rule (ctx-first for @incremental
//                        and @transform_df / @transform_pandas), runs it, and
//                        writes the output as CSV.
// ===========================================================================

/** Contents of transforms/api.py (the SDK package the user code imports). */
export const TRANSFORMS_API_PY = String.raw`"""Tellus transforms.api

A subset of Palantir Foundry's transforms-python API. Input.dataframe() returns
a pyspark.sql.DataFrame (a SparkSession is provisioned lazily in local mode);
Input.pandas() returns a pandas.DataFrame (read directly, skipping Spark);
Output.write_dataframe accepts a pyspark / pandas / stdlib DataFrame. A Context
(ctx) is injected as the first positional arg for @incremental transforms and
for @transform_df / @transform_pandas, carrying ctx.is_incremental.

    from transforms.api import transform, Output, Input
    from pyspark.sql import functions as F

    @transform(output=Output("ri.foundry.main.dataset.out"),
               source=Input("ri.foundry.main.dataset.in"))
    def my_transform(output, source):
        output.write_dataframe(source.dataframe().withColumn("x", F.lit(1)))
"""
from __future__ import annotations

import csv
import functools
import inspect
import json
import warnings
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence


# --------------------------------------------------------------------------
# Module-level constants (Track 1: Palantir-compatible API surface).
#
# Input read modes ("added" | "current" | "previous") and Output write
# modes ("replace" | "modify" | "append") are validated at call-time.
# These are the only modes Palantir Foundry's lightweight + incremental API
# exposes; anything else is a TypeError-equivalent ValueError with an
# actionable message (the discovery layer surfaces these in UI logs).
# --------------------------------------------------------------------------
_INPUT_MODES = ("added", "current", "previous")
_OUTPUT_WRITE_MODES = ("replace", "modify", "append")
_OUTPUT_READ_MODES = ("added", "current", "previous")


class AbortJobError(Exception):
    """Raised by Context.abort_job() to unwind the compute function.

    Distinct from a generic runtime error: caught ONLY by driver.py to
    translate an abort into a structured result {"ok": True, "aborted": True}
    so the build is recorded as SUCCEEDED with reason="aborted" AND commits
    NO output transaction. Palantir Foundry shows aborted transactions as
    grayed-out, successful jobs. Never propagated to user code.
    """


def _validate_write_mode(mode: Any) -> None:
    if mode is not None and mode not in _OUTPUT_WRITE_MODES:
        raise ValueError(
            "Invalid output write mode %r. Valid modes: %s."
            % (mode, ", ".join(_OUTPUT_WRITE_MODES))
        )


def _validate_read_mode(mode: Any, is_output: bool) -> None:
    allowed = _OUTPUT_READ_MODES if is_output else _INPUT_MODES
    if mode is not None and mode not in allowed:
        raise ValueError(
            "Invalid read mode %r for %s. Valid modes: %s."
            % (mode, "outputs" if is_output else "inputs", ", ".join(allowed))
        )


# --------------------------------------------------------------------------
# SparkSession — provisioned lazily, local mode. The @configure(profile=[...])
# resource hint is APPLIED here (not a no-op): CPU_* sets local[N] (cores),
# DRIVER_MEMORY_* / EXECUTOR_MEMORY_* / SINGLE_NODE_RAM_* sets
# spark.driver.memory (in local-mode the driver + executors share one JVM, so
# executor memory == driver memory). This is real allocation within what
# local-mode supports — a cluster master (spark.master=spark://...) is NOT
# implied; nothing in this shim claims distributed execution when it isn't
# happening (see the PySpark illusion audit, gap 13).
# --------------------------------------------------------------------------
_SPARK = None
# The current transform's @configure profile (set by driver.py before running
# the transform). _get_spark() reads this on first SparkSession creation so the
# profile actually configures the session (local[N] + driver memory) — a real
# allocation, not a no-op.
_TRANSFORM_PROFILE = None


# Profile -> {master, driver_memory}. A profile name maps to a concrete local-
# mode resource; the LAST matching name wins (a transform may request multiple).
_PROFILE_TABLE = {
    "DRIVER_MEMORY_SMALL": {"driver_memory": "512m"},
    "DRIVER_MEMORY_MEDIUM": {"driver_memory": "2g"},
    "DRIVER_MEMORY_LARGE": {"driver_memory": "4g"},
    "EXECUTOR_MEMORY_SMALL": {"driver_memory": "1g"},   # local: executor == driver
    "EXECUTOR_MEMORY_MEDIUM": {"driver_memory": "2g"},
    "EXECUTOR_MEMORY_LARGE": {"driver_memory": "4g"},
    "CPU_SMALL": {"master": "local[1]"},
    "CPU_MEDIUM": {"master": "local[2]"},
    "CPU_LARGE": {"master": "local[4]"},
    "SINGLE_NODE_RAM_SMALL": {"driver_memory": "512m"},
    "SINGLE_NODE_RAM_MEDIUM": {"driver_memory": "2g"},
    "SINGLE_NODE_RAM_LARGE": {"driver_memory": "4g"},
}


def _profile_config(profile):
    cfg = {"master": "local[2]", "driver_memory": "1g"}
    if profile:
        for p in profile:
            entry = _PROFILE_TABLE.get(p)
            if entry:
                cfg.update(entry)
    return cfg


def _get_spark(profile=None):
    global _SPARK
    if _SPARK is None:
        import os
        from pyspark.sql import SparkSession
        cfg = _profile_config(profile if profile is not None else _TRANSFORM_PROFILE)
        # Gap 1 (distributed execution): if TELLUS_SPARK_MASTER is set (e.g.
        # spark://spark-master:7077), the session joins that standalone cluster
        # (real master + worker JVMs) instead of local[N]. Honest label: this
        # is multi-process/multi-container Spark standalone, NOT multi-node.
        master = os.environ.get("TELLUS_SPARK_MASTER") or cfg["master"]
        builder = (
            SparkSession.builder
            .master(master)
            .appName("tellus-transform")
            .config("spark.sql.shuffle.partitions", "1")
            .config("spark.driver.memory", cfg["driver_memory"])
        )
        # Gap 1: in standalone cluster mode the executor (on a worker) must
        # reach the driver. The driver container's hostname (set by the
        # executor to its --name, resolvable on the spark-net bridge) is
        # advertised as spark.driver.host so workers can call back. Without
        # this the executor cannot resolve the driver + a task (e.g. count())
        # hangs.
        drv_host = os.environ.get("TELLUS_SPARK_DRIVER_HOST")
        if drv_host:
            builder = builder.config("spark.driver.host", drv_host).config("spark.driver.bindAddress", "0.0.0.0")
        _SPARK = builder.getOrCreate()
        try:
            _SPARK.sparkContext.setLogLevel("WARN")
        except Exception:
            pass
    return _SPARK


# --------------------------------------------------------------------------
# DataFrame — a small stdlib table for in-memory construction (e.g.
# DataFrame([...])). For dataset I/O use Input.dataframe() (pyspark) or
# Input.pandas() (pandas). Output.write_dataframe accepts all three.
# --------------------------------------------------------------------------
class DataFrame:
    def __init__(self, rows: Optional[Iterable[Dict[str, Any]]] = None,
                 columns: Optional[Sequence[str]] = None) -> None:
        self._rows: List[Dict[str, Any]] = [dict(r) for r in (rows or [])]
        if columns is not None:
            self._columns: List[str] = list(columns)
        else:
            cols: List[str] = []
            for r in self._rows:
                for k in r.keys():
                    if k not in cols:
                        cols.append(k)
            self._columns = cols

    @property
    def columns(self) -> List[str]:
        return list(self._columns)

    def count(self) -> int:
        return len(self._rows)

    def __len__(self) -> int:
        return len(self._rows)

    def __iter__(self):
        return iter(self._rows)

    def collect(self) -> List[Dict[str, Any]]:
        return [dict(r) for r in self._rows]

    def rows(self) -> List[Dict[str, Any]]:
        return self.collect()

    def head(self, n: int = 5) -> List[Dict[str, Any]]:
        return [dict(r) for r in self._rows[:n]]

    def filter(self, predicate: Callable[[Dict[str, Any]], bool]) -> "DataFrame":
        return DataFrame([r for r in self._rows if predicate(r)], self._columns)

    where = filter

    def with_column(self, name: str, fn: Callable[[Dict[str, Any]], Any]) -> "DataFrame":
        new_rows = []
        for r in self._rows:
            r2 = dict(r)
            r2[name] = fn(r)
            new_rows.append(r2)
        cols = list(self._columns)
        if name not in cols:
            cols.append(name)
        return DataFrame(new_rows, cols)

    withColumn = with_column

    def select(self, *cols: str) -> "DataFrame":
        keep = list(cols)
        return DataFrame([{c: r.get(c) for c in keep} for r in self._rows], keep)

    def drop(self, *cols: str) -> "DataFrame":
        drop = set(cols)
        keep = [c for c in self._columns if c not in drop]
        return DataFrame([{c: r.get(c) for c in keep} for r in self._rows], keep)

    def rename(self, mapping: Dict[str, str]) -> "DataFrame":
        keep = [mapping.get(c, c) for c in self._columns]
        return DataFrame(
            [{mapping.get(c, c): v for c, v in r.items()} for r in self._rows],
            keep,
        )

    withColumnRenamed = lambda self, old, new: self.rename({old: new})  # noqa: E731

    def distinct(self) -> "DataFrame":
        seen = set()
        out = []
        for r in self._rows:
            key = json.dumps(r, sort_keys=True, default=str)
            if key not in seen:
                seen.add(key)
                out.append(r)
        return DataFrame(out, self._columns)

    def limit(self, n: int) -> "DataFrame":
        return DataFrame(self._rows[:n], self._columns)

    def order_by(self, key: str, descending: bool = False) -> "DataFrame":
        rows = sorted(self._rows, key=lambda r: (r.get(key) is None, r.get(key)),
                      reverse=descending)
        return DataFrame(rows, self._columns)

    orderBy = order_by

    def union(self, other: "DataFrame") -> "DataFrame":
        cols = list(self._columns)
        for c in other.columns:
            if c not in cols:
                cols.append(c)
        return DataFrame(self._rows + other.collect(), cols)

    def to_pandas(self):
        import pandas as pd
        return pd.DataFrame(self._rows, columns=self._columns)

    @staticmethod
    def from_pandas(pdf) -> "DataFrame":
        return DataFrame(pdf.to_dict(orient="records"), list(pdf.columns))

    @staticmethod
    def read_csv(path: str) -> "DataFrame":
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = [dict(r) for r in reader]
            cols = list(reader.fieldnames or [])
        return DataFrame(rows, cols)

    def write_csv(self, path: str) -> int:
        cols = self._columns
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=cols)
            writer.writeheader()
            for r in self._rows:
                writer.writerow({c: ("" if r.get(c) is None else r.get(c)) for c in cols})
        return len(self._rows)


# --------------------------------------------------------------------------
# Input / Output.
# --------------------------------------------------------------------------
class Input:
    def __init__(self, rid: str, branch: Optional[str] = None) -> None:
        self.rid = rid
        self.branch = branch
        self._path: Optional[str] = None
        self._previous_path: Optional[str] = None
        self._format: str = "csv"
        # Populated by driver.py at bind time from the job-spec; drive the
        # Palantir read-mode semantics (added/current/previous) the spec
        # mandates beHAVE differently on incremental vs non-incremental runs.
        self._is_incremental: bool = False
        self._is_snapshot_input: bool = False
        # Binding name (the decorator kwarg name) — set by the decorator
        # factory when this Input is captured in @transform.using(...). The
        # driver also stamps it so error messages can name the parameter.
        self._binding_name: Optional[str] = None

    @property
    def binding_name(self) -> str:
        return self._binding_name or self.rid

    def _bind(self, path: str, fmt: str = "csv", previous_path: Optional[str] = None,
              is_incremental: bool = False, is_snapshot_input: bool = False) -> None:
        self._path = path
        self._format = fmt
        self._previous_path = previous_path
        self._is_incremental = bool(is_incremental)
        self._is_snapshot_input = bool(is_snapshot_input)

    def _resolve_view(self, mode: Optional[str] = None) -> Optional[str]:
        # Returns a file path ("current"/"added") OR None ("previous" on
        # a non-incremental build / no prior transaction) — the caller maps
        # None to an empty DataFrame (per Palantir's read-mode spec).
        _validate_read_mode(mode, is_output=False)
        if mode is None:
            mode = "added"
        if mode == "current":
            if self._path is None:
                raise RuntimeError("Input %r is not bound to dataset data" % self.rid)
            return self._path
        if mode == "previous":
            # During non-incremental builds, 'previous' returns no rows.
            if not self._is_incremental:
                return None
            return self._previous_path  # may be None → caller returns empty
        # mode == "added"
        # Snapshot inputs are always read in full even when 'added' is the
        # requested mode (see the snapshot_inputs section of the usage
        # guide). For ordinary incremental inputs the per-row added diff is
        # delivered via file-level transaction selection in the job-spec
        # (Phase 4); the shim returns the bound 'current' file content.
        if self._path is None:
            raise RuntimeError("Input %r is not bound to dataset data" % self.rid)
        return self._path

    def dataframe(self, mode: Optional[str] = None):
        # Returns a pyspark.sql.DataFrame (lazy Spark plan over the CSV).
        # NOTE: calling this on a lightweight (@transform.using) transform
        # starts a JVM via _get_spark() — that violates the lightweight
        # contract. Discovery + buildService surface this in logs.
        path = self._resolve_view(mode)
        if path is None:
            # mode='previous' on a non-incremental build (or with no prior
            # committed transaction) yields an empty view. For Pandas/Polars
            # (the lightweight readers) we map this to an empty DataFrame
            # (no JVM needed). pyspark is unable to materialize an empty
            # DataFrame without a SparkSession, so raise an actionable error
            # the user can guard with 'ctx.is_incremental' (mirrors the old
            # "no previous transaction" behavior; preserved as test contract).
            raise RuntimeError(
                "Input %r: mode='previous' has no prior committed transaction on "
                "this build. PySpark cannot materialize an empty DataFrame without "
                "a JVM. Use Input.pandas(mode='previous') (returns an empty pandas "
                "DataFrame without needing Java), OR guard your read with "
                "ctx.is_incremental." % self.rid
            )
        spark = _get_spark()
        return spark.read.csv(path, header=True, inferSchema=True)

    def pandas(self, mode: Optional[str] = None):
        # Returns a pandas.DataFrame (CSV read directly into RAM; skips Spark).
        import pandas as pd
        path = self._resolve_view(mode)
        if path is None:
            return pd.DataFrame()
        return pd.read_csv(path)

    def polars(self, mode: Optional[str] = None, lazy: bool = False):
        # Palantir-default for lightweight transforms. Lazily import polars
        # so a transform that never calls .polars() doesn't require the dep;
        # failure → actionable ImportError (the spec mandates we surface
        # missing optional deps loudly, not crash deep in a CSV read).
        try:
            import polars as pl
        except ImportError as exc:
            raise ImportError(
                "Input.polars() requires the 'polars' package. Install it in your "
                "repo's requirements.txt, or use Input.pandas() if only pandas is "
                "available."
            ) from exc
        path = self._resolve_view(mode)
        if path is None:
            return pl.LazyFrame() if lazy else pl.DataFrame()
        return pl.scan_csv(path) if lazy else pl.read_csv(path)

    def arrow(self, mode: Optional[str] = None):
        try:
            import pyarrow as pa
            import pyarrow.csv as pacsv
        except ImportError as exc:
            raise ImportError(
                "Input.arrow() requires the 'pyarrow' package."
            ) from exc
        path = self._resolve_view(mode)
        if path is None:
            return pa.table({})
        return pacsv.read_csv(path)


class Output:
    def __init__(self, rid: str) -> None:
        self.rid = rid
        self._path: Optional[str] = None
        self._result = None
        # Default mode determined at bind time from is_incremental: 'modify'
        # when running incrementally, 'replace' otherwise (Palantir spec
        # §IncrementalTransformOutput).
        self._mode: str = "replace"
        self._row_count: int = 0
        self._columns: List[str] = []
        self._written: bool = False
        # Previous committed output transaction's file path, used by
        # 'modify'/'append' write modes (concat with new rows) AND by
        # Output.pandas(mode='previous') (read-only history).
        self._previous_output_path: Optional[str] = None
        self._is_incremental: bool = False
        self._binding_name: Optional[str] = None

    @property
    def binding_name(self) -> str:
        return self._binding_name or self.rid

    def _bind(self, path: str, previous_output_path: Optional[str] = None,
              is_incremental: bool = False) -> None:
        self._path = path
        self._previous_output_path = previous_output_path
        self._is_incremental = bool(is_incremental)
        # Default write mode per Palantir: modify on incremental, replace on
        # non-incremental. set_mode() can still override BEFORE first write.
        self._mode = "modify" if is_incremental else "replace"

    def set_mode(self, mode: str) -> None:
        _validate_write_mode(mode)
        if self._written:
            raise RuntimeError(
                "Cannot change output write mode after writing has begun "
                "(current mode=%r, attempted=%r). Set the mode before the "
                "first write_table()/write_dataframe() call."
                % (self._mode, mode)
            )
        self._mode = mode

    def _to_pandas(self, df: Any):
        import pandas as pd
        if isinstance(df, pd.DataFrame):
            return df
        if hasattr(df, "toPandas"):  # pyspark.sql.DataFrame
            return df.toPandas()
        if hasattr(df, "collect") and not hasattr(df, "columns"):  # tellus stdlib
            return pd.DataFrame(df.collect())
        # polars.DataFrame / pyarrow.Table / iterable of dict
        try:
            return df.to_pandas()
        except AttributeError:
            return pd.DataFrame(list(df))

    def write_dataframe(self, df: Any, mode: Optional[str] = None) -> None:
        # Validate + enforce the no-mode-change-after-write rule.
        _validate_write_mode(mode)
        if mode is not None:
            if self._written and mode != self._mode:
                raise RuntimeError(
                    "Cannot change output write mode after writing has begun "
                    "(current mode=%r, attempted=%r)." % (self._mode, mode)
                )
            self._mode = mode
        if self._path is None:
            raise RuntimeError("Output %r is not bound to a path" % self.rid)
        pdf = self._to_pandas(df)
        # Apply write semantics. 'replace' overwrites self._path. 'modify' /
        # 'append' concat with the previous committed output (if any) so the
        # materialized file is the full output for this build. The backend's
        # materializeOutput translates the final mode into the dataset
        # transaction_type (SNAPSHOT vs APPEND).
        if self._mode in ("modify", "append") and self._previous_output_path:
            try:
                import pandas as pd
                prev = pd.read_csv(self._previous_output_path)
                pdf = pd.concat([prev, pdf], ignore_index=True)
            except Exception:
                # If the previous output is unreadable (missing file, schema
                # drift on first incremental, etc.) fall back to writing only
                # the new rows — the next build will reconcile.
                pass
        pdf.to_csv(self._path, index=False)
        self._result = pdf
        self._row_count = int(len(pdf))
        self._columns = list(pdf.columns)
        self._written = True

    # Palantir-recommended name for lightweight transforms; alias of
    # write_dataframe so the same accept-set (pandas/polars/arrow/pyspark/
    # stdlib DataFrame) is honored.
    write_table = write_dataframe
    write_pandas = write_dataframe

    def write_parquet(self, *_args: Any, **_kwargs: Any) -> None:
        # Loud, actionable failure: Parquet outputs are NOT supported in this
        # environment (the dataset scanner + materialize are CSV-only —
        # fileScannerService throws "Unsupported file format" for parquet, and
        # there is no JS parquet dep). A transform requesting Parquet gets this
        # explicit error, not a confusing crash later at materialize.
        raise NotImplementedError(
            "Parquet outputs are not supported in this environment (the dataset "
            "store is CSV-only). Use output.write_table(df) to write CSV. "
            "Parquet support requires a parquet scanner in the dataset store "
            "(fileScannerService) + materializeOutput changes — out of scope."
        )

    def pandas(self, mode: Optional[str] = None) -> Any:
        # Read mode for an OUTPUT dataset (distinct from Input read modes).
        # Default = "current". "previous" reads the last committed output
        # transaction (only valid on incremental builds). "added" returns
        # only the rows written in THIS build. "current" returns the union
        # of previous + this-build writes (i.e., the resulting output state).
        _validate_read_mode(mode, is_output=True)
        import pandas as pd
        if mode is None:
            mode = "current"
        if mode == "added":
            if self._result is None:
                return pd.DataFrame()
            return self._result.copy()
        if mode == "previous":
            if not self._is_incremental or self._previous_output_path is None:
                return pd.DataFrame()
            return pd.read_csv(self._previous_output_path)
        # mode == "current": previous (if any) union with this-build writes.
        rows: List[Dict[str, Any]] = []
        if self._previous_output_path and self._is_incremental:
            try:
                rows.extend(pd.read_csv(self._previous_output_path).to_dict("records"))
            except Exception:
                pass
        if self._result is not None:
            rows.extend(self._result.to_dict("records"))
        return pd.DataFrame(rows)

    def _materialize(self) -> Dict[str, Any]:
        if self._result is None:
            raise RuntimeError("Output %r was never written by the transform" % self.rid)
        if self._path is None:
            raise RuntimeError("Output %r is not bound to a path" % self.rid)
        return {
            "rid": self.rid,
            "rowCount": self._row_count,
            "columns": self._columns,
            "mode": self._mode,
            "path": self._path,
        }


# --------------------------------------------------------------------------
# Context — injected as the first positional arg for @incremental transforms
# and for @transform_df / @transform_pandas.
# --------------------------------------------------------------------------
class Context:
    def __init__(self, is_incremental: bool = False, parameters: Optional[Dict[str, Any]] = None,
                 auth: Any = None, shared_state: Optional[Dict[str, Any]] = None) -> None:
        self.is_incremental = bool(is_incremental)
        self.parameters = parameters or {}
        self.auth = auth
        self.shared_state = shared_state if shared_state is not None else {}
        self.pipeline_stats: Dict[str, Any] = {}

    @property
    def spark_session(self):
        # Lazy: the SparkSession is created on first access (with the current
        # transform's @configure profile). A transform that never touches
        # spark_session (e.g. a pandas-only @transform.using transform) pays
        # no SparkSession startup cost — that is the lightweight contract.
        return _get_spark()

    def abort_job(self) -> None:
        """Mark the whole job as successfully aborted.

        Raises AbortJobError to unwind the compute function safely. The
        driver catches it and:
          - records the build as SUCCEEDED (status='succeeded',
            reason='aborted');
          - commits NO output transaction (every Output is left unchanged);
          - discards any staged writes;
          - leaves downstream datasets NOT stale (no transaction committed);
          - marks EVERY output in a multi-output transform as aborted
            (atomic whole-job abort — partial-output aborts break
            incremental provenance, per Palantir's incremental/abort docs).
        Subsequent builds reprocess the same uncommitted input changes.

        This is the ONLY sanctioned way to short-circuit a transform:
        returning early without writing leaves the default 'modify'
        incremental output mode to commit no rows (different from an abort,
        which preserves the previous committed checkpoint untouched).
        """
        raise AbortJobError()


# --------------------------------------------------------------------------
# Decorators.
# --------------------------------------------------------------------------
class Transform:
    """Wraps a user function with its discovered I/O contract.

    Multi-output support (Palantir Foundry @transform.using): outputs is a
    Dict[name, Output]. For backward compatibility with the old single-Output
    Tellus API, self.output exposes the Output named 'output' (or, when
    absent, the first declared Output) — single-output transforms written
    with @transform(output=Output(...), source=Input(...)) keep working.
    """

    def __init__(self, fn: Callable[..., Any], kind: str,
                 outputs: Dict[str, "Output"], inputs: Dict[str, "Input"],
                 runtime: Optional[str] = None, using: bool = False) -> None:
        self.fn = fn
        self.kind = kind
        # Normalize 'output' to a single Output for legacy single-output code
        # paths (driver.py / discovery.ts: those callers must update to use
        # self.outputs when they need multi-output semantics). For the old
        # @transform(output=..., **inputs) form there is exactly one Output
        # named 'output' so this just unwraps it.
        self.outputs: Dict[str, "Output"] = outputs
        self.output: Optional["Output"] = (
            outputs.get("output") if "output" in outputs
            else (list(outputs.values())[0] if outputs else None)
        )
        self.inputs = inputs
        # Optional Python-side runtime hint ('lightweight' | 'spark').
        # Discovery/buildService uses this plus the kind to pick the executor
        # path. Set by @transform.using(...); None for the legacy
        # @transform(...) form (which the existing runtimeFor() maps to spark).
        self.runtime: Optional[str] = runtime
        # True iff the decorator form was @transform.using(...) — discovery
        # surfaces this on DiscoveredTransform so the build service records
        # 'runtime=lightweight' for @transform.using builds even when the
        # decorated kind is 'transform' (the kind stays 'transform' for
        # path portability with Foundry).
        self.using: bool = using
        self.incremental: Optional[Dict[str, Any]] = None
        self.profile: Optional[Any] = None
        self.name = getattr(fn, "__name__", "transform")
        functools.update_wrapper(self, fn)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.fn(*args, **kwargs)


def _create_transform_decorator(kind: str, runtime: Optional[str] = None,
                                using: bool = False):
    """Return a decorator-factory capturing Input/Output bindings by kwarg.

    Sorted by isinstance into outputs (Dict[name, Output]) and
    inputs (Dict[name, Input]). Validates at decoration time that every
    decorator binding name has a matching compute-function parameter, and
    every required compute-function parameter has a matching binding. The
    optional ctx parameter is exempted (passed by the driver when
    incremental). Mismatches raise a ValueError at module-import time so
    discovery surfaces a useful error instead of a deep runtime crash.
    """
    def factory(**bindings: Any) -> Callable[[Callable[..., Any]], Transform]:
        outputs: Dict[str, "Output"] = {}
        inputs: Dict[str, "Input"] = {}
        for name, val in bindings.items():
            if isinstance(val, Output):
                val._binding_name = name
                outputs[name] = val
            elif isinstance(val, Input):
                val._binding_name = name
                inputs[name] = val
            else:
                raise TypeError(
                    "Decorator binding %r must be an Input(...) or Output(...) "
                    "instance; got %r." % (name, type(val).__name__)
                )
        if not outputs:
            raise ValueError(
                "@%s decorator requires at least one Output(...) binding."
                % ("transform.using" if using else "transform")
            )
        def deco(fn: Callable[..., Any]) -> Transform:
            try:
                sig = inspect.signature(fn).parameters
            except (TypeError, ValueError):
                sig = {}
            allowed = set(inputs.keys()) | set(outputs.keys()) | {"ctx"}
            for b in list(inputs.keys()) + list(outputs.keys()):
                if b not in sig:
                    raise ValueError(
                        "Decorator binding %r has no matching parameter in "
                        "function %r. Add a parameter named %r to the function "
                        "or remove the binding from the decorator." % (b, fn.__name__, b)
                    )
            for p_name, p in sig.items():
                if p_name in allowed:
                    continue
                if p.kind in (inspect.Parameter.VAR_POSITIONAL,
                              inspect.Parameter.VAR_KEYWORD):
                    continue
                if p.default is inspect.Parameter.empty:
                    raise ValueError(
                        "Function %r requires a parameter %r that has no "
                        "matching decorator binding. Either add %r=Input(...) "
                        "or =Output(...) to the decorator, or give the "
                        "parameter a default value." % (fn.__name__, p_name, p_name)
                    )
            return Transform(fn, kind, outputs, inputs, runtime=runtime, using=using)
        return deco
    return factory


class _TransformDecorator:
    """The transform object: callable as transform(...) and
    transform.using(...), also exposes transform.spark.using(...) and
    transform.lightweight(...).

    Mapping per Palantir Foundry's lightweight-API-evolution reference:
      - transform(output=..., **inputs)        → kind 'transform', runtime 'spark' (legacy Tellus single-Output form)
      - transform.using(**bindings)           → kind 'transform', runtime 'lightweight' (RECOMMENDED default for small/medium single-node work)
      - transform.lightweight(**bindings)     → kind 'transform', runtime 'lightweight' (alias of .using)
      - transform.spark.using(**bindings)     → kind 'transform', runtime 'spark'   (PySpark distributed form)
      - transform.spark(output=..., **inputs) is intentionally NOT exposed (use @transform(...) which is spark by default)

    Backward compatibility: the existing Tellus @transform(output=..., source=...)
    form is preserved unchanged — same kind='transform', same driver calling
    convention (named bindings).
    """
    def __call__(self, **bindings: Any) -> Callable[[Callable[..., Any]], Transform]:
        return _create_transform_decorator("transform", runtime="spark", using=False)(**bindings)

    def using(self, **bindings: Any) -> Callable[[Callable[..., Any]], Transform]:
        return _create_transform_decorator("transform", runtime="lightweight", using=True)(**bindings)

    def lightweight(self, **bindings: Any) -> Callable[[Callable[..., Any]], Transform]:
        return _create_transform_decorator("transform", runtime="lightweight", using=True)(**bindings)

    @property
    def spark(self) -> "_TransformSparkDecorator":
        return _TransformSparkDecorator()


class _TransformSparkDecorator:
    """transform.spark sub-object exposing transform.spark.using(**bindings)
    for the documented PySpark form. Calling transform.spark(...) directly
    is intentionally NOT exposed (no equivalent in the Foundry API); use
    @transform(...) which defaults to spark runtime.
    """
    def using(self, **bindings: Any) -> Callable[[Callable[..., Any]], Transform]:
        return _create_transform_decorator("transform", runtime="spark", using=True)(**bindings)


transform = _TransformDecorator()


def transform_df(**bindings: Any) -> Callable[[Callable[..., Any]], Transform]:
    """@transform_df(Output(...), **inputs=Input(...)) — Spark-backed,
    return-a-DataFrame form. Backward compatible signature: positional
    Output first, then named Input kwargs. Multiple Python outputs are
    accepted (Palantir Foundry multi-output) but the canonical use is single
    Output. The fn returns a DataFrame the driver writes via
    output.write_dataframe. The decorator KIND is 'transform_df' for
    discovery routing."""
    outputs: Dict[str, "Output"] = {}
    inputs: Dict[str, "Input"] = {}
    for name, val in bindings.items():
        if isinstance(val, Output):
            val._binding_name = name
            outputs[name] = val
        elif isinstance(val, Input):
            val._binding_name = name
            inputs[name] = val
        else:
            raise TypeError("transform_df binding %r must be Input/Output" % name)
    def deco(fn: Callable[..., Any]) -> Transform:
        return Transform(fn, "transform_df", outputs, inputs)
    return deco


def transform_pandas(**bindings: Any) -> Callable[[Callable[..., Any]], Transform]:
    """@transform_pandas(Output(...), **inputs=Input(...)) — Spark-backed,
    pandas-flavoured entry. Same shape as transform_df."""
    outputs: Dict[str, "Output"] = {}
    inputs: Dict[str, "Input"] = {}
    for name, val in bindings.items():
        if isinstance(val, Output):
            val._binding_name = name
            outputs[name] = val
        elif isinstance(val, Input):
            val._binding_name = name
            inputs[name] = val
        else:
            raise TypeError("transform_pandas binding %r must be Input/Output" % name)
    def deco(fn: Callable[..., Any]) -> Transform:
        return Transform(fn, "transform_pandas", outputs, inputs)
    return deco


def lightweight(target: Any = None, **bindings: Any) -> Any:
    """@lightweight — Palantir Foundry legacy stacked form OR Tellus
    non-portable extension.

    Two recognized forms:

    1. Stacked (Palantir-portable): @lightweight over an existing
       @transform(...)-decorated function:

           @lightweight
           @transform(output=Output(...), source=Input(...))
           def fn(output, source): ...

       Here @lightweight is called WITHOUT bindings and flips the
       underlying Transform.runtime to 'lightweight'. This is the documented
       Palantir legacy form (see Lightweight API evolution reference).

    2. Tellus extension (NON-PORTABLE): @lightweight(output=...,
       source=...) — the decorator called with bindings directly, which
       creates a Transform of kind 'lightweight'. This was the old Tellus
       default. It is preserved for backward compatibility but now emits a
       DeprecationWarning directing users to the portable @transform.using(...)
       form. The Palantir docs (lightweight-api-evolution) call this form
       out as not officially supported.

    The runtime classifier in discovery.ts maps to 'lightweight' runtime
    for BOTH the stacked form AND the .using form. The kind stored on the
    Transform is 'lightweight' for the OLD Tellus extension (for
    discovery orthonormal with today's TRANSFORM_KINDS) and 'transform' for
    the stacked form (so the kind stays 'transform'; only runtime flips).
    """
    if target is None and not bindings:
        # Stacked form: @lightweight alone (no parens, no args). Target is
        # the decorated function/Transform passed positionally — Python
        # handles this by calling lightweight(target) with target=fn.
        # This branch is reached when the user writes @lightweight\n@transform(...)\ndef fn.
        # In that case Python calls us with the inner Transform as target.
        def deco(t: Any) -> Any:
            if isinstance(t, Transform):
                t.runtime = "lightweight"
                t.using = False  # Stacked legacy form — not .using
                return t
            # A bare function under @lightweight (no @transform below) is a
            # user error — they must mean the stacked form. Surface loudly.
            raise TypeError(
                "@lightweight must be stacked above @transform(...) (the "
                "Palantir-portable legacy form); use @transform.using(...) "
                "directly for the recommended modern form, OR stack "
                "@lightweight above @transform(...)."
            )
        return deco
    if bindings:
        # Tellus non-portable extension form: @lightweight(output=..., source=...).
        warnings.warn(
            "@lightweight(output=..., source=...) is a NON-PORTABLE Tellus "
            "extension. Use the Palantir-portable @transform.using(...) form "
            "for new code: stack @lightweight above @transform(...) (legacy) "
            "or use @transform.using(...). The Tellus form remains supported "
            "for backward compatibility only.",
            DeprecationWarning,
            stacklevel=2,
        )
        outputs: Dict[str, "Output"] = {}
        inputs: Dict[str, "Input"] = {}
        for name, val in bindings.items():
            if isinstance(val, Output):
                val._binding_name = name
                outputs[name] = val
            elif isinstance(val, Input):
                val._binding_name = name
                inputs[name] = val
            else:
                raise TypeError("lightweight binding %r must be Input/Output" % name)
        if target is not None:
            raise TypeError("@lightweight(**bindings) form does not take a positional target")
        def deco(fn: Callable[..., Any]) -> Transform:
            return Transform(fn, "lightweight", outputs, inputs,
                              runtime="lightweight", using=False)
        return deco
    # target provided positionally, no bindings — stacked form (the
    # decorator was applied WITHOUT being called, i.e. @lightweight).
    if isinstance(target, Transform):
        target.runtime = "lightweight"
        target.using = False
        return target
    raise TypeError(
        "@lightweight must be stacked above @transform(...) (Palantir legacy "
        "form). Use @transform.using(...) for the recommended modern API."
    )


def incremental(*_args: Any, **kwargs: Any):
    """@incremental(...) applied above @transform / @transform.using / etc.

    Records the incremental configuration on the underlying Transform so the
    build service can decide incrementality per-build and the Python driver
    can pass the resolved read/write modes into the job-spec. All Palantir
    Foundry incremental parameters are accepted and stored verbatim:
      require_incremental: bool  — fail the build when incrementality can't run
      semantic_version: int      — bumping forces a non-incremental snapshot
      snapshot_inputs: list[str] — decorator binding names to read in full
      allow_retention: bool      — ignore retention-driven deletes
      strict_append: bool        — APPEND write; overwrite raises
      v2_semantics: bool          — required for non-Catalog resources (default False)

    The decorator factory accepts being called as @incremental(...) or
    stacked bare as @incremental (no parens).
    """
    def deco(target: Any) -> Any:
        meta: Dict[str, Any] = {"enabled": True}
        meta.update(kwargs)
        # Normalize + validate known kwargs.
        if "snapshot_inputs" in meta and meta["snapshot_inputs"] is not None:
            if not isinstance(meta["snapshot_inputs"], (list, tuple)):
                raise TypeError("snapshot_inputs must be a list of binding names")
        if "semantic_version" in meta and not isinstance(meta["semantic_version"], int):
            raise TypeError("semantic_version must be an int")
        if isinstance(target, Transform):
            target.incremental = meta
        else:
            setattr(target, "_tellus_incremental", meta)
        return target
    # Detect stacked-bare form (no parens): target is the Transform/function
    # passed positionally by Python's decorator semantics.
    if _args and not kwargs and len(_args) == 1:
        # @incremental (no parens) — target is the single positional arg.
        return deco(_args[0])
    return deco


# Compatibility no-ops for richer Foundry decorators / helpers.
class Markings:
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass


class Profile:
    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass


def configure(*_args: Any, profile: Any = None, **_kwargs: Any):
    """@configure(profile=[...]) — records the requested resource profile on
    the Transform. buildService validates the names against the profile
    catalog and REJECTS unknown profiles at scheduling time (matching Foundry,
    which treats @configure as a validated resource hint). NOTE: mapping a
    profile to actual driver/executor memory requires a Spark-submit/cluster
    path — in local-mode there is no cluster to size, so the profile is
    validated + accepted but does not allocate resources (see gap 6 in
    TRANSFORMS_PARITY_GAP.md)."""
    def deco(target: Any) -> Any:
        prof = list(profile) if profile else None
        if isinstance(target, Transform):
            target.profile = prof
        else:
            setattr(target, "_tellus_profile", prof)
        return target
    return deco
`;

/** Contents of driver.py (the per-build executor entrypoint). */
export const DRIVER_PY = String.raw`"""Tellus transform build driver.

Executes exactly one discovered @transform against real dataset files and
materializes its output as CSV. Invoked as:  python3 driver.py

Job spec is passed via the TELLUS_TRANSFORM_JOB env var (JSON):
  {
    "sdkRoot":      "<dir containing transforms/api.py>",
    "modulePath":   "<absolute path to the user's transform .py file>",
    "entryPoint":   "<decorated function name>",
    "outputPath":   "<absolute path to write the output CSV>",
    "isIncremental": <bool>,
    "inputs":       [ { "param": "source", "rid": "ri...",
                        "path": "<csv>", "previousPath": "<csv|null>" } ]
  }

Foundry calling convention: a Context (ctx) is injected as the first positional
arg for @incremental transforms and for @transform_df / @transform_pandas.
@transform (non-incremental) receives (output, **inputs). transform_df /
transform_pandas RETURN a DataFrame which the driver writes via
output.write_dataframe.

Emits a single JSON object on stdout: {"ok": true, "result": {...}} or
{"ok": false, "error": "...", "traceback": "..."}.
"""
import importlib.util
import inspect
import json
import os
import sys
import traceback


def _load_user_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load transform module at %s" % path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    job = json.loads(os.environ["TELLUS_TRANSFORM_JOB"])

    # Resolve 'from transforms.api import ...' to our shim.
    sys.path.insert(0, job["sdkRoot"])

    user_mod = _load_user_module(job["modulePath"], "tellus_user_transform")
    entry = getattr(user_mod, job["entryPoint"], None)
    if entry is None:
        raise RuntimeError("entry point %r not found in %s"
                           % (job["entryPoint"], job["modulePath"]))

    is_incremental = bool(job.get("isIncremental", False))
    incremental_meta = entry.incremental or {}
    snapshot_inputs_set = set(incremental_meta.get("snapshot_inputs") or [])

    # ----- Outputs -----
    # The job-spec may carry a multi-output list ({name, rid, path, previousPath})
    # OR the legacy single outputPath field. Both are honored so existing
    # builds (which emit only outputPath) keep working unchanged.
    outputs = dict(getattr(entry, "outputs", {}) or {})
    if not outputs and getattr(entry, "output", None) is not None:
        outputs = {"output": entry.output}
    if not outputs:
        raise RuntimeError("transform %r declares no Output(...)" % job["entryPoint"])

    outputs_meta = job.get("outputs") or []
    if not outputs_meta and "outputPath" in job:
        outputs_meta = [{
            "name": list(outputs.keys())[0],
            "rid": list(outputs.values())[0].rid,
            "path": job["outputPath"],
            "previousPath": job.get("previousOutputPath"),
        }]

    bound_outputs = {}
    for o_meta in outputs_meta:
        oname = o_meta.get("name")
        if oname not in outputs:
            raise RuntimeError(
                "job-spec output %r not declared by transform %r (declared: %s)"
                % (oname, job["entryPoint"], list(outputs.keys())))
        o = outputs[oname]
        o._bind(o_meta["path"], previous_output_path=o_meta.get("previousPath"),
                is_incremental=is_incremental)
        bound_outputs[oname] = o

    # ----- Inputs -----
    bound_inputs = {}
    inputs_meta = {m["param"]: m for m in job.get("inputs", [])}
    for param, inp in (entry.inputs or {}).items():
        meta = inputs_meta.get(param)
        if meta is None or not meta.get("path"):
            raise RuntimeError(
                "input dataset for parameter %r (rid=%s) could not be resolved"
                % (param, getattr(inp, "rid", "?")))
        is_snapshot_input = param in snapshot_inputs_set
        inp._bind(meta["path"], meta.get("format", "csv"),
                  previous_path=meta.get("previousPath"),
                  is_incremental=is_incremental, is_snapshot_input=is_snapshot_input)
        bound_inputs[param] = inp

    # ----- Context injection -----
    # Inject ctx when EITHER:
    #  • the @incremental decorator is stacked above (per Palantir Foundry:
    #    IncrementalTransformContext.is_incremental exposes the build mode), OR
    #  • the decorator kind is transform_df / transform_pandas (existing
    #    Foundry calling convention), OR
    #  • the compute function's signature explicitly names a 'ctx' parameter
    #    (Palantir Foundry lightweight-API-evolution + the basic transforms
    #    reference: "your compute function must accept a parameter called ctx"
    #    to opt into the TransFormContext — used for ctx.abort_job() /
    #    ctx.duckdb() / ctx.is_incremental on lightweight forms without an
    #    @incremental decorator).
    needs_ctx = bool(entry.incremental) or entry.kind in ("transform_df", "transform_pandas")
    if not needs_ctx:
        try:
            sig_params = inspect.signature(entry.fn).parameters
            if "ctx" in sig_params:
                needs_ctx = True
        except (TypeError, ValueError):
            pass
    ctx = None
    if needs_ctx:
        from transforms.api import Context
        ctx = Context(is_incremental=is_incremental)

    # Apply the @configure profile to the SparkSession (real allocation, not a
    # no-op): set the module-level _TRANSFORM_PROFILE so _get_spark() (called
    # lazily by Input.dataframe() or ctx.spark_session) configures local[N] +
    # spark.driver.memory from the profile.
    import transforms.api as _ta
    _ta._TRANSFORM_PROFILE = getattr(entry, "profile", None)
    AbortJobError = _ta.AbortJobError

    # ----- Run the user fn -----
    # Pass ALL bindings by name (ctx + inputs + outputs). This is the
    # Palantir Foundry calling convention — @transform.using(**bindings) —
    # and also works for the legacy @transform(output=..., **inputs) form
    # because the function signature names match the binding names. (A
    # transform written def fn(output, source): ... accepts
    # fn(output=..., source=...) by name.)
    bindings_by_name = {}
    if ctx is not None:
        bindings_by_name["ctx"] = ctx
    bindings_by_name.update(bound_inputs)
    # transform / lightweight (incl. @transform.using): the user fn receives
    # Outputs as NAMED bindings (writes via output.write_table inside the fn).
    # transform_df / transform_pandas: the function RETURNS a DataFrame;
    # outputs are NOT bound into the call (the driver writes them via
    # output.write_table(result_df) afterward). Mixing forms would surface
    # an unexpected 'output' kwarg into a single-Output transform_pandas fn
    # signature like 'def f(ctx): return DataFrame(...)' — TypeError on call.
    if entry.kind in ("transform", "lightweight"):
        bindings_by_name.update(bound_outputs)

    try:
        if entry.kind in ("transform", "lightweight"):
            entry.fn(**bindings_by_name)
        else:
            result_df = entry.fn(**bindings_by_name)
            # transform_df / transform_pandas: the return value is the output.
            # In multi-output form this is non-standard; route the result to
            # the first output (single-output is the canonical form for these
            # decorator kinds anyway).
            first_output_name = list(bound_outputs.keys())[0]
            bound_outputs[first_output_name].write_table(result_df)
    except AbortJobError:
        # Whole-job abort — leave every output UNCHANGED (no transaction),
        # discard any staged writes, do NOT mark downstreams stale, preserve
        # the last committed incremental checkpoint. The build service records
        # status=succeeded + reason=aborted. Distinct from a runtime error —
        # caught here so the build is green-gray per the Foundry UI.
        sys.stdout.write(json.dumps({
            "ok": True,
            "aborted": True,
            "result": {"aborted": True, "outputs": []}
        }))
        return

    # ----- Materialize each output -----
    outputs_result = []
    for oname, o in bound_outputs.items():
        try:
            outputs_result.append(o._materialize())
        except RuntimeError:
            # Output never written: per the spec a successful transform with
            # no writes leaves the previous output unchanged (modify/append)
            # or yields an empty snapshot (replace). The build service decides
            # whether to commit an empty txn or skip via the noWrite flag.
            outputs_result.append({
                "rid": getattr(o, "rid", None),
                "rowCount": 0,
                "columns": [],
                "mode": o._mode,
                "path": o._path,
                "noWrite": True,
            })

    if len(outputs_result) == 1:
        sys.stdout.write(json.dumps({"ok": True, "result": outputs_result[0]}))
    else:
        sys.stdout.write(json.dumps({"ok": True, "result": {"outputs": outputs_result}}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — surface every failure as JSON
        sys.stdout.write(json.dumps({
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        }))
        sys.exit(1)
`;

