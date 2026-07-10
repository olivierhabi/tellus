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
#
# Conda-build env shim (see _conda_build_env): Foundry's setup.py uses
# name=os.environ['PKG_NAME'] / version=os.environ['PKG_VERSION'] (conda-build
# sets these from meta.yaml at build time). tellus's build sets them so the
# Foundry-verbatim setup.py is pip-installable WITHOUT editing — a Foundry repo
# works unchanged. This is an original tellus build behavior (mimics conda-build):
#   # original implementation, not a port

import argparse
import importlib.metadata
import os
import subprocess
import sys


def _conda_build_env(repo_dir: str = ".") -> dict:
    """Conda-build env vars for a Foundry-verbatim setup.py
    (name=os.environ['PKG_NAME'], version=os.environ['PKG_VERSION']).

    PKG_NAME is derived from the package dir under src/ (the dir containing
    __init__.py); PKG_VERSION defaults to 0.1.0 (meta.yaml uses the
    {{ PACKAGE_VERSION }} token, which is unresolved outside Foundry's Hawk).
    """
    env = dict(os.environ)
    src = os.path.join(repo_dir, "src")
    pkg_name = None
    if os.path.isdir(src):
        for name in sorted(os.listdir(src)):
            if os.path.isfile(os.path.join(src, name, "__init__.py")):
                pkg_name = name
                break
    env["PKG_NAME"] = pkg_name or "tellus_transform"
    env.setdefault("PKG_VERSION", "0.1.0")
    return env


def discover(entry_point_group: str = "transforms.pipelines",
             install: bool = False, repo_dir: str = ".") -> int:
    """Resolve the project's Pipeline via the transforms.pipelines entry point
    (Source: project-structure setup.py) and list its discovered transforms.

    With --install: pip install -e <repo_dir>/src first (Foundry layout: setup.py
    lives at src/setup.py), setting the conda-build env vars (PKG_NAME/PKG_VERSION)
    so the Foundry-verbatim setup.py's os.environ['PKG_NAME'] resolves without
    editing the repo. Then resolve the entry point via importlib.metadata."""
    if install:
        env = _conda_build_env(repo_dir)
        setup_py_dir = os.path.join(repo_dir, "src")
        print(f"[tellus-transforms] install -e {setup_py_dir} "
              f"(PKG_NAME={env.get('PKG_NAME')}, PKG_VERSION={env.get('PKG_VERSION')})",
              flush=True)
        rc = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-e", setup_py_dir], env=env
        ).returncode
        if rc != 0:
            return rc
        # The just-installed package's import finder was added to site-packages by
        # the pip subprocess, but THIS process's import machinery was initialized
        # at startup (before the install) — so re-spawn `discover` in a fresh
        # process that loads the new finder, then resolves the entry point.
        return subprocess.run(
            [sys.executable, "-m", "tellus_transforms.cli", "discover", "--repo-dir", repo_dir]
        ).returncode
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


def check() -> int:
    """Run lint (pycodestyle + pylint) + test (pytest) + build.
    Equivalent in OUTCOME to Foundry's Checks; the orchestration is tellus-original.
    The build step runs with the conda-build env shim so the Foundry-verbatim
    setup.py (os.environ['PKG_NAME']) resolves."""
    steps = [
        ("lint:pycodestyle", ["pycodestyle", "src"], None),
        ("lint:pylint", ["pylint", "src"], None),
        ("test:pytest", ["pytest", "-q"], None),
        ("build", ["python", "-m", "build", "src"], _conda_build_env(".")),
    ]
    rc = 0
    for name, cmd, env in steps:
        print(f"[tellus-transforms] {name}: {' '.join(cmd)}", flush=True)
        rc = rc or subprocess.run(cmd, env=env).returncode
    return rc


def lock() -> int:
    """Resolve conda_recipe/meta.yaml run-deps -> requirements.lock via pip-tools.
    Replaces Foundry's Hawk resolution (Hawk algorithm UNVERIFIED)."""
    print("[tellus-transforms] lock: pip-compile (replaces Hawk)", flush=True)
    return subprocess.run([
        "pip-compile", "--output-file", "requirements.lock",
        "conda_recipe/meta.yaml",
    ]).returncode


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="tellus-transforms")
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover", help="list transforms via the transforms.pipelines entry point")
    d.add_argument("--install", action="store_true",
                   help="pip install -e . first (sets PKG_NAME/PKG_VERSION so the "
                        "Foundry-verbatim setup.py resolves without editing)")
    d.add_argument("--repo-dir", default=".", help="repo dir to install/discover (default: .)")
    sub.add_parser("check", help="lint + test + build (Foundry Checks equivalent)")
    sub.add_parser("lock", help="resolve meta.yaml deps -> requirements.lock (pip-tools)")
    a = p.parse_args(argv)
    if a.cmd == "discover":
        return discover(install=a.install, repo_dir=a.repo_dir)
    return {"check": check, "lock": lock}[a.cmd]()


if __name__ == "__main__":
    sys.exit(main())
