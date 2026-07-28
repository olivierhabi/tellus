# OSS v2 populated acceptance fixture

`populated.dump` is a PostgreSQL custom-format dump containing only synthetic
acceptance data. It was captured from the independently verified `d733e99`
candidate after migrations 001–141 and is used to reproduce populated-upgrade,
reindex, transaction, scenario, action, interface, and subscription tests in a
new PostgreSQL container.

The fixture contains no credentials, bearer tokens, private keys, signed media
URLs, or production data. Restore it into an empty database with:

```sh
pg_restore --exit-on-error --no-owner --no-acl \
  --username tellus --dbname tellus_db populated.dump
```

After restore, run `pnpm exec tsx src/migrate.ts` to verify that applying the
current migration set to a populated database remains idempotent.
