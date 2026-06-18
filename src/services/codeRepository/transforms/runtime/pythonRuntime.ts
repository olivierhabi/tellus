// ===========================================================================
// Python runtime assets for the transform build engine.
//
// These are emitted to a per-build temp workdir by executor.ts and executed
// with `python3`. They are embedded as string constants (rather than shipped
// as .py files) so they are available identically under tsx (dev/test) and a
// compiled dist/ build with no asset-copy step.
//
//   transforms/api.py  — a faithful, dependency-free subset of Foundry's
//                        transforms-python API (transform / transform_df /
//                        transform_pandas / incremental, Input / Output, and a
//                        pure-stdlib DataFrame that runs without pandas/PySpark;
//                        upgrades transparently to pandas via .pandas()).
//   driver.py          — binds one @transform to real dataset files, runs it,
//                        and writes the output as CSV.
// ===========================================================================

/** Contents of `transforms/api.py` (the SDK package the user code imports). */
export const TRANSFORMS_API_PY = String.raw`"""Tellus transforms.api

A faithful, dependency-free subset of Palantir Foundry's transforms-python API,
used by the Tellus Code Repositories transform build engine. User transform code
authored as

    from transforms.api import transform, Output, Input

    @transform(output=Output("ri.foundry.main.dataset.out"),
               source=Input("ri.foundry.main.dataset.in"))
    def my_transform(output, source):
        output.write_dataframe(source.dataframe().filter(lambda r: r["amount"] > 0))

runs unchanged. The DataFrame is a pure-stdlib columnar table (no pandas/Spark
required); .pandas() returns a real pandas.DataFrame when pandas is installed.
"""
from __future__ import annotations

import csv
import functools
import json
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence


# --------------------------------------------------------------------------
# DataFrame — a small, faithful subset of the Spark/pandas DataFrame surface.
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

    # -- introspection ----------------------------------------------------
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

    # -- transformations (each returns a new DataFrame) -------------------
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

    # -- pandas interop ---------------------------------------------------
    def to_pandas(self):
        import pandas as pd  # optional dependency
        return pd.DataFrame(self._rows, columns=self._columns)

    @staticmethod
    def from_pandas(pdf) -> "DataFrame":
        return DataFrame(pdf.to_dict(orient="records"), list(pdf.columns))

    # -- CSV io (the on-disk dataset format) ------------------------------
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
# Input / Output aliases.
# --------------------------------------------------------------------------
class Input:
    def __init__(self, rid: str, branch: Optional[str] = None) -> None:
        self.rid = rid
        self.branch = branch
        self._path: Optional[str] = None
        self._format: str = "csv"

    def _bind(self, path: str, fmt: str = "csv") -> None:
        self._path = path
        self._format = fmt

    def dataframe(self) -> DataFrame:
        if self._path is None:
            raise RuntimeError("Input %r is not bound to dataset data" % self.rid)
        return DataFrame.read_csv(self._path)

    def pandas(self):
        return self.dataframe().to_pandas()


class Output:
    def __init__(self, rid: str) -> None:
        self.rid = rid
        self._path: Optional[str] = None
        self._result: Optional[DataFrame] = None
        self._mode: str = "replace"

    def _bind(self, path: str) -> None:
        self._path = path

    def write_dataframe(self, df: Any, mode: str = "replace") -> None:
        self._mode = mode
        if not isinstance(df, DataFrame):
            try:
                import pandas as pd
                if isinstance(df, pd.DataFrame):
                    df = DataFrame.from_pandas(df)
            except Exception:
                pass
        if not isinstance(df, DataFrame):
            df = DataFrame(list(df))
        self._result = df

    write_pandas = write_dataframe

    def _materialize(self) -> Dict[str, Any]:
        if self._result is None:
            raise RuntimeError("Output %r was never written by the transform" % self.rid)
        if self._path is None:
            raise RuntimeError("Output %r is not bound to a path" % self.rid)
        n = self._result.write_csv(self._path)
        return {
            "rid": self.rid,
            "rowCount": n,
            "columns": self._result.columns,
            "mode": self._mode,
            "path": self._path,
        }


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


def configure(*_args: Any, **_kwargs: Any):
    def deco(target: Any) -> Any:
        return target
    return deco
`;

/** Contents of `driver.py` (the per-build executor entrypoint). */
export const DRIVER_PY = String.raw`"""Tellus transform build driver.

Executes exactly one discovered @transform against real dataset files and
materializes its output as CSV. Invoked as:  python3 driver.py

Job spec is passed via the TELLUS_TRANSFORM_JOB env var (JSON):
  {
    "sdkRoot":    "<dir containing transforms/api.py>",
    "modulePath": "<absolute path to the user's transform .py file>",
    "entryPoint": "<decorated function name>",
    "outputPath": "<absolute path to write the output CSV>",
    "inputs":     [ { "param": "source", "rid": "ri...", "path": "<csv>" } ]
  }

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

    # Resolve 'from transforms.api import ...' to our shim. The user module is
    # loaded by file path (not as part of the transforms package) so there is
    # no collision with a repo-level transforms/ directory.
    sys.path.insert(0, job["sdkRoot"])

    user_mod = _load_user_module(job["modulePath"], "tellus_user_transform")
    entry = getattr(user_mod, job["entryPoint"], None)
    if entry is None:
        raise RuntimeError("entry point %r not found in %s"
                           % (job["entryPoint"], job["modulePath"]))

    # entry is a transforms.api.Transform (decorated). Bind its I/O.
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
        inp._bind(meta["path"], meta.get("format", "csv"))
        bound_inputs[param] = inp

    if entry.kind == "transform":
        entry.fn(output, **bound_inputs)
    else:  # transform_df / transform_pandas: the return value is the output
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
