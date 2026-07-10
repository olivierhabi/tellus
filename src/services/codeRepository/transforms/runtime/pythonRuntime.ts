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

/** Contents of `transforms/api.py` (the SDK package the user code imports). */
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
import json
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence


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

    def _bind(self, path: str, fmt: str = "csv", previous_path: Optional[str] = None) -> None:
        self._path = path
        self._format = fmt
        self._previous_path = previous_path

    def _resolved_path(self, mode: Optional[str] = None) -> str:
        if mode == "previous":
            if self._previous_path is None:
                raise RuntimeError(
                    "Input %r has no previous transaction (mode='previous' is "
                    "only valid on incremental builds with prior state)" % self.rid)
            return self._previous_path
        if self._path is None:
            raise RuntimeError("Input %r is not bound to dataset data" % self.rid)
        return self._path

    def dataframe(self, mode: Optional[str] = None):
        # Returns a pyspark.sql.DataFrame (lazy Spark plan over the CSV).
        path = self._resolved_path(mode)
        spark = _get_spark()
        return spark.read.csv(path, header=True, inferSchema=True)

    def pandas(self, mode: Optional[str] = None):
        # Returns a pandas.DataFrame (CSV read directly into RAM; skips Spark).
        import pandas as pd
        path = self._resolved_path(mode)
        return pd.read_csv(path)


class Output:
    def __init__(self, rid: str) -> None:
        self.rid = rid
        self._path: Optional[str] = None
        self._result = None
        self._mode: str = "replace"
        self._row_count: int = 0
        self._columns: List[str] = []

    def _bind(self, path: str) -> None:
        self._path = path

    def set_mode(self, mode: str) -> None:
        # Foundry: "replace" (SNAPSHOT) | "modify" / "append" (APPEND).
        self._mode = mode

    def write_dataframe(self, df: Any, mode: Optional[str] = None) -> None:
        if mode:
            self._mode = mode
        import pandas as pd
        if isinstance(df, pd.DataFrame):
            pdf = df
        elif hasattr(df, "toPandas"):  # pyspark.sql.DataFrame
            pdf = df.toPandas()
        elif hasattr(df, "collect"):  # tellus stdlib DataFrame
            pdf = pd.DataFrame(df.collect())
        else:
            pdf = pd.DataFrame(list(df))
        if self._path is None:
            raise RuntimeError("Output %r is not bound to a path" % self.rid)
        pdf.to_csv(self._path, index=False)
        self._result = pdf
        self._row_count = int(len(pdf))
        self._columns = list(pdf.columns)

    write_pandas = write_dataframe

    def write_parquet(self, *_args: Any, **_kwargs: Any) -> None:
        # Loud, actionable failure: Parquet outputs are NOT supported in this
        # environment (the dataset scanner + materialize are CSV-only —
        # fileScannerService throws "Unsupported file format" for parquet, and
        # there is no JS parquet dep). A transform requesting Parquet gets this
        # explicit error, not a confusing crash later at materialize.
        raise NotImplementedError(
            "Parquet outputs are not supported in this environment (the dataset "
            "store is CSV-only). Use output.write_dataframe(df) to write CSV. "
            "Parquet support requires a parquet scanner in the dataset store "
            "(fileScannerService) + materializeOutput changes — out of scope."
        )

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
        # spark_session (e.g. a pandas-only transform) pays no SparkSession
        # startup cost.
        return _get_spark()


# --------------------------------------------------------------------------
# Decorators.
# --------------------------------------------------------------------------
class Transform:
    """Wraps a user function with its discovered I/O contract."""

    def __init__(self, fn: Callable[..., Any], kind: str, output: Optional[Output],
                 inputs: Dict[str, Input]) -> None:
        self.fn = fn
        self.kind = kind
        self.output = output
        self.inputs = inputs
        self.incremental: Optional[Dict[str, Any]] = None
        self.profile: Optional[Any] = None
        self.name = getattr(fn, "__name__", "transform")
        functools.update_wrapper(self, fn)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.fn(*args, **kwargs)


def transform(output: Optional[Output] = None, **inputs: Input):
    def deco(fn: Callable[..., Any]) -> Transform:
        return Transform(fn, "transform", output, inputs)
    return deco


def transform_df(output: Optional[Output] = None, **inputs: Input):
    def deco(fn: Callable[..., Any]) -> Transform:
        return Transform(fn, "transform_df", output, inputs)
    return deco


def transform_pandas(output: Optional[Output] = None, **inputs: Input):
    def deco(fn: Callable[..., Any]) -> Transform:
        return Transform(fn, "transform_pandas", output, inputs)
    return deco


def incremental(*_args: Any, **kwargs: Any):
    """@incremental(...) applied above @transform; records incremental intent
    (snapshot vs append/modify write semantics)."""
    def deco(target: Any) -> Any:
        meta = {"enabled": True}
        meta.update(kwargs)
        if isinstance(target, Transform):
            target.incremental = meta
        else:
            setattr(target, "_tellus_incremental", meta)
        return target
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

/** Contents of `driver.py` (the per-build executor entrypoint). */
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

    output = entry.output
    if output is None:
        raise RuntimeError("transform %r declares no Output(...)" % job["entryPoint"])
    output._bind(job["outputPath"])

    bound_inputs = {}
    inputs_meta = {m["param"]: m for m in job.get("inputs", [])}
    for param, inp in (entry.inputs or {}).items():
        meta = inputs_meta.get(param)
        if meta is None or not meta.get("path"):
            raise RuntimeError(
                "input dataset for parameter %r (rid=%s) could not be resolved"
                % (param, getattr(inp, "rid", "?")))
        inp._bind(meta["path"], meta.get("format", "csv"),
                  previous_path=meta.get("previousPath"))
        bound_inputs[param] = inp

    # Foundry ctx injection rule: @incremental OR @transform_df/@transform_pandas.
    needs_ctx = bool(entry.incremental) or entry.kind in ("transform_df", "transform_pandas")
    ctx = None
    if needs_ctx:
        from transforms.api import Context
        ctx = Context(is_incremental=bool(job.get("isIncremental", False)))

    # Apply the @configure profile to the SparkSession (real allocation, not a
    # no-op): set the module-level _TRANSFORM_PROFILE so _get_spark() (called
    # lazily by Input.dataframe() or ctx.spark_session) configures local[N] +
    # spark.driver.memory from the profile.
    import transforms.api as _ta
    _ta._TRANSFORM_PROFILE = getattr(entry, "profile", None)

    if entry.kind == "transform":
        if needs_ctx:
            entry.fn(ctx, output, **bound_inputs)
        else:
            entry.fn(output, **bound_inputs)
    else:  # transform_df / transform_pandas: the return value is the output
        if needs_ctx:
            result_df = entry.fn(ctx, **bound_inputs)
        else:
            result_df = entry.fn(**bound_inputs)
        output.write_dataframe(result_df)

    result = output._materialize()
    sys.stdout.write(json.dumps({"ok": True, "result": result}))


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
