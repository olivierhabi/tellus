# Sources

A **source** is a logical handle on an external system that Tellus can read
from (and, in CDC mode, subscribe to). Every source lives inside a Compass
folder, owns one driver-specific configuration block, and is bound to a vault
secret that holds its credentials.

This page is the operator reference for the PostgreSQL driver. Other drivers
follow the same lifecycle.

## Lifecycle

1. **Create.** `POST /api/v1/connectivity/connections`. The wizard at
   `/data-connection/sources/new/postgresql` walks an operator through name,
   parent folder, worker placement (direct or agent group), config and
   credentials, with idempotency keyed by browser session.
2. **Test.** `POST .../connections/:rid/test`. Server-side rate-limited to
   1/min. Returns `{ ok, latencyMs, serverVersion }`.
3. **Discover.** `GET .../connections/:rid/discovery`. Lists schemas, tables,
   columns, and foreign keys; powers downstream snapshot / append / CDC /
   virtual-table wizards.
4. **Edit.** `PUT .../connections/:rid`. Requires `If-Match` ETag. Drops
   pool, recreates with the new config; running imports continue against the
   old pool until their next checkpoint.
5. **Disable.** `PUT .../connections/:rid/status` to `disabled`. Imports
   refuse new runs; existing pools drain.
6. **Delete.** `DELETE .../connections/:rid`. Soft-deleted, restorable within
   24 h; permanently dropped after the soft-delete window expires.

## Required folder permission

Operators need the Compass `compass:write` scope on the parent folder. The
backend asserts this on every mutation; the UI surfaces `<PermissionGate>` to
hide the New / Edit / Delete affordances if the scope is missing.

## Health states

| Status     | Meaning                                                    |
|------------|------------------------------------------------------------|
| `pending`  | Created but `/test` has not yet succeeded.                 |
| `active`   | Last `/test` succeeded within the past 60 s.               |
| `degraded` | Last `/test` failed but at least one ran in the past 5 m.  |
| `failed`   | Last 3 `/test` runs failed.                                |
| `disabled` | Operator-set; refuses new imports.                         |

## Errors operators see

* `Tellus:Connectivity:NameConflictInFolder` — pick a unique slug.
* `Tellus:Connectivity:FolderNotFound` — parent folder RID is stale.
* `Tellus:Connectivity:JdbcAuthFailed` — credentials wrong; rotate via the
  detail page.
* `Tellus:Connectivity:TlsVerificationFailed` — re-upload the CA PEM.
* `Tellus:Connectivity:ResourceVersionMismatch` — concurrent edit; reload.
* `Tellus:Connectivity:HasActiveDependencies` — cannot delete with imports.

The full registry lives in `src/lib/errors/registry.ts`.
