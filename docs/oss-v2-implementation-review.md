# Tellus OSS/OMS v2 implementation review

Reviewed: 2026-07-28
Contract baseline: `@osdk/foundry.ontologies@2.70.0`

## Outcome

Tellus now has one canonical ObjectSet compiler/executor behind the v2
ObjectSet, object, link, action, and metadata adapters. The reviewed OSS/OMS
slice scores **84/100** for functional Foundry compatibility.

This is deliberately not a score for cloning all of Palantir Foundry. It
measures the Ontology Object Storage/Object Set/metadata surface implemented
in this repository.

## Score

| Area | Weight | Score | Evidence |
| --- | ---: | ---: | --- |
| Public contract fidelity | 20 | 18 | SDK 2.70 drift gate; exact ObjectSet paths; strict body/query validation; v2 error envelopes |
| ObjectSet algebra and filters | 20 | 19 | 15 ObjectSet nodes; 28 SearchJsonQueryV2 discriminators; same/cross-type algebra; interface property translation |
| Loading, paging, snapshots, aggregation | 20 | 17 | HMAC-bound keyset tokens; PIT snapshots; multi-type merge; derived properties; aggregation accuracy gate |
| Security, branches, identity | 15 | 13 | one read choke point; security filter and branch injection; fail-closed get; persistent RID hydration |
| OMS, links, and actions | 15 | 12 | ObjectType/LinkType/ActionType/Interface adapters; link traversal/loadLinks; validate/execute action modes and edit returns |
| Realtime and operational maturity | 10 | 5 | tested internal subscription registry, migration/backfill operator, contract/unit gates; no authenticated public ObjectSet stream |
| **Total** | **100** | **84** | |

## Implemented

- The public ObjectSet endpoints exposed by the 2.70 SDK:
  `createTemporary`, `get`, `loadObjects`,
  `loadObjectsMultipleObjectTypes`, `loadObjectsOrInterfaces`, `aggregate`,
  and `loadLinks`.
- Stable ObjectSet parsing with bounded depth/node counts and exact
  discriminated unions.
- Same-type and cross-type set algebra, references, static sets, interface
  implementations/inheritance, concrete and interface link traversal,
  vector nearest neighbors, and derived properties.
- All SDK 2.70 SearchJsonQueryV2 discriminators, including relative date,
  text, interval, regex/wildcard, bounding-box/polygon/distance, and
  `geoShapeV2`.
- Signed page tokens bound to ontology, branch, tenant, request shape, and
  ObjectSet fingerprint.
- Point-in-time snapshot paging with fail-closed overlay-lag checks.
- Aggregation metrics/grouping with explicit accurate-versus-approximate
  behavior.
- Action v2 apply/applyBatch, the documented batch limit, validation-only
  execution, validation bodies, edit return modes, and notification
  suppression where the internal engine cannot provide batch semantics.
- OMS v2 mapping for object, property, action, link, and interface metadata,
  including inherited interface properties and implementations. Action
  operations use the SDK's high-level `LogicRule` union; the live catalog of
  284 legacy/current action types serializes without invented discriminators.
- Persistent object RIDs, online/resumable historical backfill, and
  read-time hydration for pre-RID OpenSearch documents. Datasource-only
  deterministic RIDs are recorded in the compact `object_rid_lookup`, so a
  returned RID can be used later by static ObjectSets and `loadLinks`.

## Explicitly unavailable

These inputs fail with typed v2 errors instead of being silently ignored:

- ontology transaction and scenario reads;
- `executeInMemoryOnly`;
- property-security value wrapping;
- signed media references and advanced property load levels;
- text-to-vector embedding for nearest-neighbor queries;
- distinct reverse-side link API names (Tellus currently has one canonical
  link name), and interface-link action summaries because the SDK 2.70
  `LogicRule` union has no interface-link discriminator.

The in-memory subscription registry is an internal prototype. An
authenticated, resumable public ObjectSet update stream with durable cursors
is not shipped, so realtime maturity receives only half credit.

## Verification

- `npm run contract:check-oss-v2`
- `npx tsc --noEmit`
- `npx vitest run --config vitest.unit.config.ts tests/unit/actions/ tests/unit/services/`
- focused OSS route, compiler, executor, aggregation, actions, OMS, security,
  store, and subscription tests
- live Postgres RID backfill/index validation and authenticated local API
  smoke tests, including datasource RID round-trip, static resolution,
  `loadLinks`, and the complete 284-entry action metadata catalog

## Contract sources

- [Load Object Set](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/ontology-object-sets/load-object-set/)
- [Load Multiple Object Types](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/ontology-object-sets/load-object-set-multiple-object-types/)
- [Load Objects or Interfaces](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/ontology-object-sets/load-object-set-objects-or-interfaces/)
- [Aggregate Object Set](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/ontology-object-sets/aggregate-object-set/)
- [Apply Action](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/actions/apply-action/)
- [Apply Action Batch](https://www.palantir.com/docs/foundry/api/v2/ontologies-v2-resources/actions/apply-action-batch/)
