# transforms/api.py
# Public developer-facing surface reproducing the DOCUMENTED signatures of
# Foundry's `transforms.api`, so transform code written for Foundry is portable
# to tellus verbatim. Sources (per symbol):
#   @transform / @transform.using / @transform.lightweight / @transform.spark.using
#     https://www.palantir.com/docs/foundry/transforms-python/getting-started/
#     https://www.palantir.com/docs/foundry/transforms-python/lightweight-api-evolution/
#     https://www.palantir.com/docs/foundry/transforms-python/compute-engines/
#   Input / Output / LightweightInput / LightweightOutput (+ .polars()/.write_table())
#     https://www.palantir.com/docs/foundry/transforms-python/project-structure/
#   Pipeline / discover_transforms / add_transforms
#     https://www.palantir.com/docs/foundry/transforms-python/pipelines/
#
# The data-access methods (.polars()/.pandas()/.duckdb()/write_table()) are
# DECLARED here for DX-compatibility but their data BACKING is tellus-runtime-
# provided at build time — see the UNVERIFIED note at the bottom. Foundry's
# Hawk-backed dataset I/O algorithm is not publicly documented.

from __future__ import annotations

import importlib
import inspect
import pkgutil
import types
from dataclasses import dataclass
from typing import Callable, Mapping

__all__ = [
    "Input", "Output", "LightweightInput", "LightweightOutput",
    "Transform", "Pipeline", "transform",
]


class _DatasetRef:
    """A dataset reference declared by path string.
    Source: getting-started/compute-engines — Input("/path/..."), Output("/path/...")."""

    def __init__(self, path: str):
        if not isinstance(path, str) or not path:
            raise TypeError(
                f"{type(self).__name__}() requires a non-empty dataset path string"
            )
        self.path = path

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.path!r})"

    def __eq__(self, other: object) -> bool:
        return isinstance(other, _DatasetRef) and type(self) is type(other) and self.path == other.path

    def __hash__(self) -> int:
        return hash((type(self).__name__, self.path))


class Input(_DatasetRef):
    """Input("/path/to/input/dataset").

    .polars()/.pandas()/.duckdb() are the documented runtime interface
    (getting-started: `df = meteorite_landings.polars()`). They are backed by
    the tellus build runtime when the transform executes; the author-facing
    Input is a path declaration. See UNVERIFIED note below.
    """

    def polars(self, *, lazy: bool = False):  # Source: project-structure (polars(lazy=True))
        raise NotImplementedError("tellus build runtime provides Input.polars()")

    def pandas(self):  # Source: lightweight-api-evolution (input.pandas())
        raise NotImplementedError("tellus build runtime provides Input.pandas()")

    def duckdb(self):  # Source: getting-started (ctx.duckdb())
        raise NotImplementedError("tellus build runtime provides Input.duckdb()")


class Output(_DatasetRef):
    """Output("/path/to/output/dataset"). write_table() is runtime-backed."""

    def write_table(self, df) -> None:  # Source: getting-started (output.write_table(df))
        raise NotImplementedError("tellus build runtime provides Output.write_table()")


class LightweightInput(Input):
    """Typed alias for the lightweight (Polars) engine.
    Source: project-structure examples.py — def compute(input_dataset: LightweightInput, ...)."""


class LightweightOutput(Output):
    """Typed alias for the lightweight (Polars) engine. Source: project-structure."""


@dataclass
class Transform:
    """A registered transform (created by the @transform decorators; collected
    by a Pipeline). Users do not construct this directly."""

    func: Callable[..., None]
    output_name: str
    output: Output
    inputs: Mapping[str, Input]
    engine: str  # "unified" | "lightweight" | "spark"
    name: str = ""

    def __post_init__(self) -> None:
        if not self.name:
            self.name = self.func.__name__

    @property
    def output_path(self) -> str:
        return self.output.path


class _DecoratorFactory:
    """Returned by @transform / @transform.using / @transform.spark.using.

    Called with keyword bindings whose values are Output(...) / Input(...).
    The Output is identified BY TYPE (not name) so both documented forms work:
      @transform(output=Output(...), meteorite_landings=Input(...))         # getting-started
      @transform.using(output_dataset=Output(...), input_dataset=Input(...)) # project-structure
    Each binding NAME must match a function parameter name (DX binding).
    """

    def __init__(self, engine: str):
        self._engine = engine

    def __call__(self, **bindings: _DatasetRef):
        outputs = {n: v for n, v in bindings.items() if isinstance(v, Output)}
        inputs = {n: v for n, v in bindings.items() if isinstance(v, Input)}
        bad = {n: v for n, v in bindings.items()
               if not isinstance(v, (Input, Output))}
        if bad:
            raise TypeError(
                "@transform bindings must be Input(...) or Output(...); "
                f"unexpected: { {n: type(v).__name__ for n, v in bad.items()} }"
            )
        if len(outputs) != 1:
            raise TypeError(
                f"@transform requires exactly one Output(...) binding (got {len(outputs)})"
            )
        out_name, out = next(iter(outputs.items()))

        def decorate(func: Callable[..., None]) -> Transform:
            params = list(inspect.signature(func).parameters.values())
            positional = [p for p in params if p.kind in (
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                inspect.Parameter.POSITIONAL_ONLY,
            )]
            # Optional leading ctx param (compute context). Source: getting-started.
            has_ctx = bool(positional and positional[0].name == "ctx")
            declared = {p.name for p in (positional[1:] if has_ctx else positional)}
            expected = set(inputs) | {out_name}
            missing = expected - declared
            if missing:
                raise TypeError(
                    f"{func.__name__}() missing parameter(s) for binding(s): {sorted(missing)}"
                )
            return Transform(
                func=func, output_name=out_name, output=out,
                inputs=dict(inputs), engine=self._engine,
            )

        return decorate


class _SparkNamespace:
    """transform.spark.using(...). Source: compute-engines (@transform.spark.using)."""

    def __init__(self) -> None:
        self.using = _DecoratorFactory("spark")


class _TransformNamespace:
    """The `transform` decorator namespace.
      @transform(...)             — unified (engine chosen at runtime via .polars()/.pandas()/.duckdb())
      @transform.using(...)       — lightweight (Polars/pandas)
      @transform.lightweight(...) — alias for .using
      @transform.spark.using(...) — Spark
    """

    def __init__(self) -> None:
        self.using = _DecoratorFactory("lightweight")
        self.lightweight = self.using  # alias. Source: lightweight-api-evolution.
        self.spark = _SparkNamespace()

    def __call__(self, **bindings: _DatasetRef):  # @transform(...) — unified
        return _DecoratorFactory("unified")(**bindings)


transform = _TransformNamespace()  # module-level singleton


class Pipeline:
    """A registry of Transforms. Source: pipelines page.

      my_pipeline = Pipeline()
      my_pipeline.discover_transforms(datasets)   # automatic
      my_pipeline.add_transforms(fn1, fn2, ...)   # manual
    """

    def __init__(self) -> None:
        self._transforms: list[Transform] = []
        self._outputs: dict[str, str] = {}  # output_path -> transform_name
        self._added_ids: set[int] = set()   # id() of already-added Transform objects

    def add_transforms(self, *transforms: Transform) -> None:
        """Add transforms manually; raises if two transforms declare the same
        output dataset. Source: pipelines (#manual-registration)."""
        for t in transforms:
            if not isinstance(t, Transform):
                raise TypeError(
                    f"add_transforms() expects Transform objects, got {type(t).__name__}"
                )
            if id(t) in self._added_ids:
                continue  # re-exported / re-added same object: no-op (not a duplicate)
            if t.output_path in self._outputs:
                raise ValueError(
                    f"Output dataset {t.output_path!r} already declared by "
                    f"{self._outputs[t.output_path]!r}; cannot also be declared by {t.name!r}"
                )
            self._added_ids.add(id(t))
            self._outputs[t.output_path] = t.name
            self._transforms.append(t)

    def discover_transforms(self, module: "types.ModuleType | str") -> None:
        """Recursively import the module/package and collect every module-level
        @transform-decorated function. Source: pipelines (#automatic-registration):
        'recursively discovers all transforms in a Python module or package ...
        imports every module it finds.'"""
        if isinstance(module, str):
            module = importlib.import_module(module)
        self._collect(module, set())

    def _collect(self, module: types.ModuleType, seen: set[str]) -> None:
        if module.__name__ in seen:
            return
        seen.add(module.__name__)
        for attr in vars(module).values():
            if isinstance(attr, Transform):
                self.add_transforms(attr)
        if hasattr(module, "__path__"):  # package → recurse submodules
            for _finder, name, _ispkg in pkgutil.iter_modules(module.__path__):
                full = f"{module.__name__}.{name}"
                try:
                    sub = importlib.import_module(full)
                except ImportError:
                    continue
                self._collect(sub, seen)

    @property
    def transforms(self) -> list[Transform]:
        return list(self._transforms)


# --- UNVERIFIED / runtime boundary -----------------------------------------
# The data-access methods on Input/Output (.polars()/.pandas()/.duckdb()/
# write_table()) are DECLARED above for DX-compatibility (code written for
# Foundry calls them verbatim) but their BACKING — reading/writing real
# datasets — is tellus-runtime-provided at build time. Foundry's Hawk-backed
# dataset I/O is named in `environment-overview` but its algorithm is NOT
# publicly documented:
#   # UNVERIFIED — no public doc source, needs product decision
# tellus's build runtime will substitute runtime Input/Output objects (with
# real dataset data) when invoking each Transform; the author-facing classes
# above are declaration objects (path holders) + the method interface only.
