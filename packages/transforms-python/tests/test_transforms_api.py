# tests/test_transforms_api.py
# Unit tests for transforms.api: binding (decorator→Transform field mapping,
# both the unified `output=`/`<name>=` form and the typed
# `output_dataset=`/`input_dataset=` lightweight form), validation (bad
# bindings, missing params, duplicate outputs), and recursion
# (discover_transforms across modules + a nested sub-package).
# Sources for the behaviors under test are cited in transforms/api.py.

import pytest

from transforms.api import (
    Input, Output, LightweightInput, LightweightOutput,
    Pipeline, Transform, transform,
)
from tests.fixtures import datasets as fix_datasets


# --- Binding --------------------------------------------------------------

class TestBinding:
    def test_unified_decorator_binds_output_and_inputs_by_name(self):
        @transform(output=Output("/o"), a=Input("/a"), b=Input("/b"))
        def f(output, a, b):
            df = a.polars()
            output.write_table(df)

        assert isinstance(f, Transform)
        assert f.engine == "unified"
        assert f.name == "f"
        assert f.output == Output("/o")
        assert f.output_name == "output"
        assert f.output_path == "/o"
        assert f.inputs == {"a": Input("/a"), "b": Input("/b")}

    def test_typed_lightweight_form_output_dataset_input_dataset(self):
        # project-structure examples.py shape: Output identified by type, not name.
        @transform.using(output_dataset=Output("/o"), input_dataset=Input("/i"))
        def compute(input_dataset: LightweightInput, output_dataset: LightweightOutput) -> None:
            output_dataset.write_table(input_dataset.polars(lazy=True))

        assert compute.engine == "lightweight"
        assert compute.output_name == "output_dataset"
        assert compute.inputs == {"input_dataset": Input("/i")}
        assert compute.output == Output("/o")

    def test_transform_using_is_lightweight_engine(self):
        @transform.using(output=Output("/o"), input=Input("/i"))
        def clean(output, input):
            output.write_table(input.pandas())

        assert clean.engine == "lightweight"

    def test_transform_lightweight_is_an_alias_of_using(self):
        assert transform.lightweight is transform.using

    def test_transform_spark_using(self):
        @transform.spark.using(output=Output("/o"), input=Input("/i"))
        def clean(output, input):
            output.write_table(input.polars())

        assert clean.engine == "spark"

    def test_optional_ctx_first_param(self):
        @transform(output=Output("/o"), a=Input("/a"))
        def f(ctx, output, a):
            conn = ctx.duckdb().conn  # noqa: context object (getting-started DuckDB form)
            output.write_table(conn.sql("SELECT 1"))

        # ctx is not a binding — only `a` is an input, `output` is the output.
        assert set(f.inputs) == {"a"}
        assert f.output_name == "output"


# --- Validation -----------------------------------------------------------

class TestValidation:
    def test_no_output_binding_raises(self):
        with pytest.raises(TypeError, match="exactly one Output"):
            @transform(a=Input("/a"))
            def f(output, a): ...

    def test_two_output_bindings_raise(self):
        with pytest.raises(TypeError, match="exactly one Output"):
            @transform(output=Output("/o1"), output2=Output("/o2"))
            def f(output, output2): ...

    def test_non_dataset_binding_raises(self):
        with pytest.raises(TypeError, match="must be Input"):
            @transform(output=Output("/o"), a="not-a-ref")
            def f(output, a): ...

    def test_function_missing_param_for_binding_raises(self):
        with pytest.raises(TypeError, match="missing parameter"):
            @transform(output=Output("/o"), a=Input("/a"))
            def f(output):  # no `a` param
                ...

    def test_input_requires_nonempty_path_string(self):
        with pytest.raises(TypeError):
            Input("")
        with pytest.raises(TypeError):
            Input(None)  # type: ignore[arg-type]

    def test_add_transforms_rejects_non_transform(self):
        p = Pipeline()
        with pytest.raises(TypeError, match="Transform"):
            p.add_transforms("not a transform")

    def test_add_transforms_rejects_duplicate_output_path(self):
        @transform(output=Output("/dup"), a=Input("/a"))
        def f1(output, a): ...

        @transform(output=Output("/dup"), b=Input("/b"))
        def f2(output, b): ...

        p = Pipeline()
        p.add_transforms(f1)
        with pytest.raises(ValueError, match="/dup"):
            p.add_transforms(f2)

    def test_add_transforms_same_object_twice_is_noop(self):
        @transform(output=Output("/o"), a=Input("/a"))
        def f(output, a): ...

        p = Pipeline()
        p.add_transforms(f)
        p.add_transforms(f)  # same object — no-op, not a duplicate-output error
        assert len(p.transforms) == 1


# --- Recursion (discover_transforms) -------------------------------------

class TestDiscover:
    def test_discovers_transforms_across_modules_and_nested_package(self):
        p = Pipeline()
        p.discover_transforms(fix_datasets)

        by_name = {t.name: t for t in p.transforms}
        assert set(by_name) == {"clean_a", "clean_b", "clean_c"}
        # clean_c lives in the nested sub-package `datasets.sub` — proves recursion.
        assert by_name["clean_a"].engine == "unified"
        assert by_name["clean_b"].engine == "lightweight"
        assert by_name["clean_c"].engine == "spark"
        assert by_name["clean_a"].output_path == "/a/out"
        assert by_name["clean_c"].output_path == "/c/out"

    def test_discover_transforms_accepts_dotted_module_path_string(self):
        p = Pipeline()
        p.discover_transforms("tests.fixtures.datasets")
        assert {t.name for t in p.transforms} == {"clean_a", "clean_b", "clean_c"}

    def test_discover_is_idempotent_for_already_added_objects(self):
        # Re-running discover on the same package re-imports the same Transform
        # objects (cached in sys.modules); the identity-skip makes this a no-op
        # rather than a duplicate-output error.
        p = Pipeline()
        p.discover_transforms(fix_datasets)
        p.discover_transforms(fix_datasets)
        assert len(p.transforms) == 3
