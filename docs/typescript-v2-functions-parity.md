# TypeScript Functions v2 public-parity contract

This document is the evidence boundary for the Tellus implementation. It does
not claim access to Palantir source code or private service contracts. “Parity”
means behavior supported by public Palantir documentation and public patent
filings, verified through Tellus integration tests.

## Publicly documented requirements

| Requirement | Public evidence | Tellus status |
| --- | --- | --- |
| V2 functions live below `typescript-functions/src/functions`, including nested directories | [TypeScript v2 getting started](https://www.palantir.com/docs/foundry/functions/typescript-v2-getting-started) | Implemented |
| File basename matches function name and the function is the default export | [TypeScript v2 getting started](https://www.palantir.com/docs/foundry/functions/typescript-v2-getting-started) | Implemented and unit tested |
| Source path is the stable function identity; moving a file creates a new function | [TypeScript v2 getting started](https://www.palantir.com/docs/foundry/functions/typescript-v2-getting-started) | Implemented with stable `ri.function-registry.main.function.*` RIDs |
| Inputs and output have explicit, supported registry types | [Functions type reference](https://www.palantir.com/docs/foundry/functions/types-reference) | Explicit annotations enforced; full registry-type validation remains |
| Commit starts checks; Checks supports branch filtering and run detail | [Code Repositories navigation](https://www.palantir.com/docs/foundry/code-repositories/navigation) | Real history, stages, cancellation, polling, and logs implemented |
| Tag and release publishes all functions in the repository | [TypeScript v2 getting started](https://www.palantir.com/docs/foundry/functions/typescript-v2-getting-started) | Durable `functions-publish` pipeline implemented |
| Versions are immutable SemVer releases | [Function versioning](https://www.palantir.com/docs/foundry/functions/functions-versioning) | Existing immutable bundle registry retained |
| Compatibility checks cover dropped functions/inputs, input ordering, required additions, and input/output type changes | [Function versioning](https://www.palantir.com/docs/foundry/functions/functions-versioning) | Signature metadata and blocking major-version checks implemented |
| Stable releases can be restricted to protected branches; prereleases may be released from feature branches | [Branch settings](https://www.palantir.com/docs/foundry/code-repositories/branch-settings) | Data model exists; protected-branch release policy remains |
| Registry resources expose an RID and selected version | [Functions v2 Get Query API](https://www.palantir.com/docs/foundry/api/functions-v2-resources/queries/get-query) | Version-aware registry endpoint and overview UI implemented |
| Checks/code assistance load permitted Ontology resources and generate bindings | [Functions permissions](https://www.palantir.com/docs/foundry/functions/permissions) | Resource import loading exists; build-time permission/codegen parity remains |
| TypeScript v2 executes in a full Node.js runtime, commonly serverless | [Language feature support](https://www.palantir.com/docs/foundry/functions/language-feature-support) | Node execution exists; production serverless isolation/autoscaling remains |

The Palantir patent application [US20210029132A1](https://patents.google.com/patent/US20210029132A1/en)
describes inheriting a resource container's granular access-control policy for
embedded artifacts. It supports treating a published function artifact as a
repository-contained governed resource. It does **not** disclose the
`functions-publish` implementation, Jemma, Gradle task names, registry schema,
or Foundry service topology, so it cannot prove exact internal parity.

## Tellus release acceptance criteria

1. A release request returns `202` and a durable `ri.jemma.main.run.*` RID.
2. Multiple API replicas claim queued/expired work with `FOR UPDATE SKIP LOCKED`
   and leases; the configured concurrency bound is honored per replica.
3. `setup`, `lint`, `test`, `build`, and `publish` transitions and timestamps
   are persisted. Logs are append-only and pageable.
4. The branch head is pinned at enqueue time; a moved ref fails the release.
5. Discovery, explicit signatures, syntax, immutability, and backward
   compatibility pass before registration.
6. The artifact is content-addressed, each source path receives a stable
   function RID, and every function/version points to the immutable release.
7. `/code-repositories/repo/:rid?section=checks` renders database state only;
   no timers or mock check arrays synthesize results.
8. `/:functionRid/overview?version=X.Y.Z` resolves the exact function version.

## Remaining production gates

- Execute dependency installation, lint, unit tests, code generation, and
  bundling inside an isolated, resource-limited worker image rather than the
  API process. The current worker validates source and signatures but does not
  execute repository test code.
- Validate every public Function Registry type and custom type recursively.
- Enforce protected-branch stable-release policy and repository-scoped publish
  authorization.
- Propagate repository/Compass access policy to function resources and
  artifacts; audit all reads and publication mutations.
- Store bundles in durable object storage/OCI, sign them, scan dependencies,
  generate SBOM/provenance, and verify signatures before execution.
- Add a serverless Node runtime with per-version routing, resource settings,
  timeouts, autoscaling, consistent Ontology snapshots, and permission-aware
  OSDK clients.
- Add failure, cancellation, lease-expiry, concurrency, compatibility, and
  artifact-corruption integration/chaos tests.

Until these gates are complete, Tellus has a production-shaped publishing
control plane and working full-stack flow, not a defensible “100% clone” of
Palantir's proprietary implementation.
