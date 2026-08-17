# Tellus transform runtime image. Built once, used for:
#   - Gap 3: sandboxed/containerized transform execution (driver runs here with
#     --network=none --read-only --memory/--cpus caps; arbitrary user code
#     cannot reach the host FS / network / unbounded resources).
#   - Gap 1: Spark standalone cluster (master/worker + driver, all Spark 3.5.3).
# Verified by scripts/verify-transforms-sandbox.sh (CI: transforms-parity parity-e2e).
#
# Base apache/spark:3.5.3 ships Spark 3.5.3 + Java 11 + Python 3.8 + pyspark at
# /opt/spark/python (+ py4j zip). We add pandas<2.1 + pyarrow<15 (py3.8-
# compatible; the shim's write_dataframe does df.toPandas()). PYTHONPATH must
# list the pyspark.zip + py4j zip — the spark image leaves PYTHONPATH empty
# (its entrypoint sets it at runtime), so a bare `python3` needs it in ENV.
#
# Build:
#   docker build -t tellus/transform-runtime:py38 -f scripts/transform-runtime.Dockerfile scripts
FROM apache/spark:3.5.3
USER root
ENV PYTHONPATH=/opt/spark/python:/opt/spark/python/lib/pyspark.zip:/opt/spark/python/lib/py4j-0.10.9.7-src.zip
ENV PYSPARK_PYTHON=python3
ENV PYSPARK_DRIVER_PYTHON=python3
RUN pip install --no-cache-dir 'pandas<2.1' 'pyarrow<15' && \
    python3 -c "import pyspark, pandas, pyarrow; print('runtime ok', pyspark.__version__, pandas.__version__, pyarrow.__version__)"
USER spark
WORKDIR /work
