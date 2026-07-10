#!/usr/bin/env bash
# scaffold-tellus-transforms.sh
# Scaffolds the tellus transforms framework + a reference transform repo to $DEST.
# The transforms.api library + tests are copied from the passing POC
# (/tmp/tellus-transforms-poc — 17/17 green); the reference-repo build files are
# written here. Every file is traceable to a Palantir doc URL / OSS doc / labeled
# original — see in-file headers.
set -euo pipefail
DEST="${1:-./tellus-transforms}"
POC="/tmp/tellus-transforms-poc"

echo "[scaffold] target: $DEST"
mkdir -p "$DEST/transforms" "$DEST/tests/fixtures/datasets/sub" \
         "$DEST/src/myproject/datasets" "$DEST/conda_recipe" "$DEST/tellus_transforms"

# 1. transforms.api library + passing tests (copied verbatim from the POC).
if [[ -d "$POC" ]]; then
  cp "$POC/transforms/api.py" "$POC/transforms/__init__.py" "$DEST/transforms/"
  cp -r "$POC/tests/." "$DEST/tests/"
  cp "$POC/conftest.py" "$POC/setup.cfg" "$DEST/"
  echo "[scaffold] copied transforms/ + tests/ from POC (17/17 passing)"
else
  echo "WARN: POC at $POC not found — re-create transforms/api.py + tests first." >&2
fi

# 2. Reference transform repo — src/<project>/ layout (project-structure page).
cat > "$DEST/src/myproject/__init__.py" <<'EOF'
# Empty package marker. Source: https://www.palantir.com/docs/foundry/transforms-python/project-structure/
EOF

cat > "$DEST/src/myproject/pipeline.py" <<'EOF'
# Source: https://www.palantir.com/docs/foundry/transforms-python/project-structure/
# (default src/<project>/pipeline.py, 4 lines, verbatim).
from transforms.api import Pipeline
from myproject import datasets

my_pipeline = Pipeline()
my_pipeline.discover_transforms(datasets)
EOF

: > "$DEST/src/myproject/datasets/__init__.py"

cat > "$DEST/src/myproject/datasets/examples.py" <<'EOF'
# Source: https://www.palantir.com/docs/foundry/transforms-python/project-structure/
# Default src/<project>/datasets/examples.py ships COMMENTED OUT
# ("an uncommented version of the default"). Uncomment + fill real dataset paths to build.
#
# from transforms.api import Input, Output, transform, LightweightInput, LightweightOutput
#
#
# @transform.using(
#     output_dataset=Output("/path/to/output/dataset"),
#     input_dataset=Input("/path/to/input/dataset"),
# )
# def compute(input_dataset: LightweightInput, output_dataset: LightweightOutput) -> None:
#     output_dataset.write_table(input_dataset.polars(lazy=True))
EOF

# 3. setup.py — transforms.pipelines entry point (DX-portable discovery contract).
cat > "$DEST/src/setup.py" <<'EOF'
# Source: https://www.palantir.com/docs/foundry/transforms-python/project-structure/
# DEVIATION: Foundry uses name=os.environ['PKG_NAME'] / version=os.environ['PKG_VERSION']
# (conda-build env vars, inert under tellus's setuptools build) — tellus uses concrete values.
#   # UNVERIFIED — author='{{REPOSITORY_ORG_NAME}}' is a Foundry template var; tellus has no
#   # org-name source, so it is omitted (not fabricated).
from setuptools import find_packages, setup

setup(
    name="myproject",
    version="0.1.0",
    description="Python data transformation project",
    packages=find_packages(exclude=["contrib", "docs", "test"]),
    install_requires=[],  # declare runtime dependencies in conda_recipe/meta.yaml
    entry_points={
        "transforms.pipelines": [
            "root = myproject.pipeline:my_pipeline",
        ]
    },
)
EOF

# 4. setup.cfg — tool config (Foundry's body is UNVERIFIED; tellus uses OSS config).
cat > "$DEST/src/setup.cfg" <<'EOF'
# Source: https://www.palantir.com/docs/foundry/transforms-python/project-structure/
# (setup.cfg exists in the default tree; its DEFAULT CONTENTS are NOT documented):
#   # UNVERIFIED — no public doc source for Foundry's setup.cfg body, needs product decision
# tellus tool config, grounded in OSS docs (pytest / pycodestyle / pylint).
[tool:pytest]
testpaths = tests
python_files = test_*.py
python_functions = test_*

[pycodestyle]
max-line-length = 120
exclude = build,dist,.venv

[pylint]
disable =
    missing-module-docstring,
    missing-class-docstring,
    missing-function-docstring
max-line-length = 120
EOF

# 5. conda_recipe/meta.yaml — Foundry-shape (DX-portable); resolved via pip-tools (not Hawk).
cat > "$DEST/conda_recipe/meta.yaml" <<'EOF'
# Source: https://www.palantir.com/docs/foundry/transforms-python/project-structure/
# Foundry-shape (DX-portable). Foundry uses {{ PACKAGE_NAME }} / {{ PYTHON_TRANSFORMS_VERSION }}
# substituted by the Hawk package manager (environment-overview); Hawk's algorithm is UNVERIFIED:
#   # UNVERIFIED — no public doc source for Hawk's resolution, needs product decision
# tellus uses CONCRETE values + resolves run-deps via pip-tools (see requirements.lock):
#   # original implementation, not a port

package:
  name: myproject
  version: 0.1.0

source:
  path: ../src

requirements:
  build:
    - python 3.9.*
    - setuptools
  run:
    - python 3.9.*
    - transforms            # tellus publishes the `transforms` package (transforms.api)
    # transforms-expectations, transforms-verbs: Foundry sub-packages.
    #   # UNVERIFIED — tellus equivalents not yet defined, needs product decision

build:
  script: python setup.py install --single-version-externally-managed --record=record.txt
EOF

# 6. requirements.lock — pip-tools lock (replaces Hawk). Original tellus design.
cat > "$DEST/requirements.lock" <<'EOF'
# Source: pip-tools https://pip-tools.readthedocs.io/ (pip-compile output).
# tellus resolves conda_recipe/meta.yaml `requirements.run` via pip-compile -> this lock,
# replacing Foundry's Hawk resolution (Hawk algorithm UNVERIFIED).
#   # original implementation, not a port
#
# Generated by: tellus-transforms lock   (do not edit by hand)
#   pip-compile --output-file requirements.lock conda_recipe/meta.yaml

transforms==0.1.0       # tellus's transforms.api package
polars==0.20.*          # lightweight compute engine (Input.polars())
# pyspark, pandas, duckdb: pulled per @transform.spark.using / .pandas() / .duckdb() usage
EOF

# 7. pyproject.toml — PEP 517 build config (replaces Gradle python/python-defaults).
cat > "$DEST/pyproject.toml" <<'EOF'
# Source: PEP 517/518 (https://peps.python.org/pep-0517/) + https://build.pypa.io/
# + https://setuptools.pypa.io/. Replaces Foundry's Gradle python/python-defaults plugins;
# tellus does not use Gradle or com.palantir.* plugin IDs.
#   # original implementation, not a port

[build-system]
requires = ["setuptools>=68", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "myproject"
version = "0.1.0"
description = "Python data transformation project"
requires-python = ">=3.9"
dependencies = [
    "transforms",  # tellus's transforms.api package
    # transforms-expectations, transforms-verbs: UNVERIFIED tellus equivalents
]

[tool.setuptools]
package-dir = {"" = "src"}
EOF

# 8. tellus_transforms CLI — build/test/lint orchestration (replaces Gradle Checks).
: > "$DEST/tellus_transforms/__init__.py"
cat > "$DEST/tellus_transforms/cli.py" <<'EOF'
# Source: original tellus design. Replaces Foundry's Gradle Checks orchestration
# (https://www.palantir.com/docs/foundry/code-repositories/create-custom-checks/).
# tellus does not use Gradle or any com.palantir.* plugin identifier.
#   # original implementation, not a port
#
# Foundry Gradle plugin -> Python tool:
#   python / python-defaults -> setuptools + `python -m build` (PEP 517)
#   pytest-defaults          -> pytest          https://docs.pytest.org/
#   pep8                     -> pycodestyle     https://pycodestyle.readthedocs.io/
#   pylint                   -> pylint          https://pylint.readthedocs.io/
#   Hawk dep resolution      -> pip-tools       https://pip-tools.readthedocs.io/  (Hawk UNVERIFIED)
# Checks/branch orchestration semantics are NOT publicly documented:
#   # UNVERIFIED — no public doc source, needs product decision

import argparse
import importlib.metadata
import subprocess
import sys


def discover(entry_point_group="transforms.pipelines"):
    """Resolve the project's Pipeline via the transforms.pipelines entry point
    (Source: project-structure setup.py) and list its discovered transforms."""
    eps = importlib.metadata.entry_points()
    group = (
        eps.select(group=entry_point_group)
        if hasattr(eps, "select")  # Py3.10+
        else eps.get(entry_point_group, [])
    )
    found = list(group)
    if not found:
        print(f"no {entry_point_group!r} entry point found - is the package installed?",
              file=sys.stderr)
        return 2
    for ep in found:
        pipeline = ep.load()
        print(f"# pipeline: {ep.value}")
        for t in pipeline.transforms:
            print(f"{t.name}\t{t.output.path}\t{t.engine}\t{', '.join(t.inputs)}")
    return 0


def check():
    """Run lint (pycodestyle + pylint) + test (pytest) + build.
    Equivalent in OUTCOME to Foundry's Checks; the orchestration is tellus-original."""
    steps = [
        ("lint:pycodestyle", ["pycodestyle", "src"]),
        ("lint:pylint", ["pylint", "src"]),
        ("test:pytest", ["pytest", "-q"]),
        ("build", ["python", "-m", "build"]),
    ]
    rc = 0
    for name, cmd in steps:
        print(f"[tellus-transforms] {name}: {' '.join(cmd)}", flush=True)
        rc = rc or subprocess.run(cmd).returncode
    return rc


def lock():
    """Resolve conda_recipe/meta.yaml run-deps -> requirements.lock via pip-tools.
    Replaces Foundry's Hawk resolution (Hawk algorithm UNVERIFIED)."""
    print("[tellus-transforms] lock: pip-compile (replaces Hawk)", flush=True)
    return subprocess.run([
        "pip-compile", "--output-file", "requirements.lock",
        "conda_recipe/meta.yaml",
    ]).returncode


def main(argv=None):
    p = argparse.ArgumentParser(prog="tellus-transforms")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("discover", help="list transforms via the transforms.pipelines entry point")
    sub.add_parser("check", help="lint + test + build (Foundry Checks equivalent)")
    sub.add_parser("lock", help="resolve meta.yaml deps -> requirements.lock (pip-tools)")
    a = p.parse_args(argv)
    return {"discover": discover, "check": check, "lock": lock}[a.cmd]()


if __name__ == "__main__":
    sys.exit(main())
EOF

# 9. Makefile — convenience orchestration.
cat > "$DEST/Makefile" <<'EOF'
# Source: original tellus orchestration (replaces Foundry Gradle Checks).
#   # original implementation, not a port
.PHONY: discover check lint test build lock

discover:
	tellus-transforms discover
lint:
	pycodestyle src && pylint src
test:
	pytest -q
build:
	python -m build
lock:
	tellus-transforms lock
check: lint test build
EOF

echo "[scaffold] done. Tree:"
find "$DEST" -type f | sort
echo
echo "[scaffold] re-run the tests at the target to confirm:"
echo "  cd $DEST && python -m pytest -q"
