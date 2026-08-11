# Rwanda operational-platform QA fixtures

Generate functional-tier fixtures:

```sh
npx tsx tools/synthetic-data/generate.ts --tier functional --seed 4242 --out /tmp/tellus-rwanda-qa
```

Generate the scale tier:

```sh
npx tsx tools/synthetic-data/generate.ts --tier scale --seed 4242 --out /var/tmp/tellus-rwanda-scale
```

The generator writes a run-scoped `QA-RW` namespace, one CSV per scenario
object type, dirty-ingestion CSVs, exact expected function outputs, and a
checksum manifest. It does not invoke Tellus APIs: callers must ingest these
files through the normal pipeline and verify cleanup through an authenticated
test helper.

Verify a generated run, including the rule that Luhn-valid PANs appear only
in the explicitly raw ingestion fixture:

```sh
npx tsx tools/synthetic-data/verify.ts --out /tmp/tellus-rwanda-qa
```

## Normal-path QA ingestion

The functional tier can be loaded through the supported CSV upload, backing
datasource, and reindex APIs. The helper uses the non-production test-auth
bypass and creates only `QaRw*` object types, so it must never be used against
production.

```bash
TELLUS_TEST_HOOKS=1 npx tsx tools/synthetic-data/ingest.ts --out /tmp/tellus-rwanda-qa
```

For an ingestion smoke test that proves cleanup, append `--cleanup`; the
command fails unless every run-scoped object type is gone afterward.

It excludes dirty fixtures, expected-output files, and the raw ISO-8583 input:
those fixtures are exercised by their dedicated ingestion-quality and PCI tests.
