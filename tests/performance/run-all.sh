#!/usr/bin/env bash
# Run all performance benchmarks
set -euo pipefail

npx tsx tests/performance/benchmark.ts
npx tsx tests/performance/sundayBenchmark.ts
