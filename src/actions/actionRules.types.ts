// ---------------------------------------------------------------------------
// Canonical Action Rule Domain Types
//
// Single source of truth for the discriminated-union shape of every Action
// Type rule, side-effect config, writeback config, and value source that
// the Tellus Ontology backend persists, validates, compiles, executes, and
// audits — and that the Tellus frontend authors, round-trips, and renders.
//
// This module is TYPE-ONLY (erased at runtime). It is mirrored verbatim into
// the frontend (`lib/actionRules.types.ts`) so both codebases share one
// canonical schema. NEVER duplicate the runtime logic that consumes these
// types — duplicate ONLY the type declarations. When this file changes, run
// `scripts/sync-action-rules-types.mjs` (or copy manually) into the FE.
//
// Naming follows Tellus ontology conventions (stable apiName identifiers in
// persisted data; display labels live in `displayName` / UI-only layers and
// are NEVER part of a rule body). The ontology identifiers used here are
// `linkType.apiName`, `objectType.apiName`, `interface.apiName`,
// `interfaceLinkConstraint.apiName`, `webhookDefinition.id + version` — never
// human-readable labels.
//
// Discipline:
//   - Discriminated unions on `type`. Every consumer MUST exhaustively switch
//     on `type` and assertNever() on the default branch.
//   - No `any`, no `// @ts-ignore`, no broad casts. Every field that crosses
//     the wire is typed.
//   - Versioning: action_type.definition_version (DB) + definition_hash guard
//     optimistic concurrency. Rule bodies are immutable for a given version.
//   - Legacy compatibility aliases are declared REMARKED as such — canonical
//     persistence always emits the canonical field; legacy fields are accepted
//     on input only.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Value sources — the right-hand side of every property / reference mapping
// ---------------------------------------------------------------------------

/**
 * Tag union for ValueSource discriminant.
 * - `parameter`         — value comes from a validated action input parameter.
 * - `static`            — literal value baked into the rule definition.
 * - `currentTimestamp`  — server-side `now()` at the moment of execution.
 * - `currentUser`       — the executing actor's principal id.
 * - `writebackResponse` — a typed output from a preceding writeback webhook
 *                         (Phase 4). The outputId is validated against the
 *                         webhook version's output schema at save time; the
 *                         path is JSONPointer-validated and type-inferred.
 */
export type ValueSourceTag =
  | "parameter"
  | "static"
  | "currentTimestamp"
  | "currentUser"
  | "writebackResponse";

export interface ParameterValueSource {
  readonly source: "parameter";
  /** apiName of a parameter declared on this Action Type. */
  readonly param: string;
  /**
   * Optional: for `object_reference` parameters, the referenced object type's
   * apiName. Carried for compile-time type-checking at save time; the runtime
   * already validates this against `parameters[].objectType`.
   */
  readonly objectType?: string;
}

export interface StaticValueSource {
  readonly source: "static";
  /** Literal value — validated JSON (no function sources, no eval). */
  readonly value: string | number | boolean | null | ReadonlyArray<unknown> | Readonly<Record<string, unknown>>;
}

export interface CurrentTimestampValueSource {
  readonly source: "currentTimestamp";
}

export interface CurrentUserValueSource {
  readonly source: "currentUser";
}

export interface WritebackResponseValueSource {
  readonly source: "writebackResponse";
  /** Id of an output declared by the referenced webhook version's outputSchema. */
  readonly outputId: string;
  /**
   * JSONPointer (RFC 6901) into the typed output object. MUST be inside the
   * sub-schema identified by `outputId`. Validated at save time.
   */
  readonly path?: string;
}

export type ValueSource =
  | ParameterValueSource
  | StaticValueSource
  | CurrentTimestampValueSource
  | CurrentUserValueSource
  | WritebackResponseValueSource;

// ---------------------------------------------------------------------------
// Object rules
// ---------------------------------------------------------------------------

export interface CreateObjectRule {
  readonly type: "createObject";
  readonly objectType: string;
  /** apiName → ValueSource. Required: every primary-key + required property. */
  readonly properties: Readonly<Record<string, ValueSource>>;
}

export interface ModifyObjectRule {
  readonly type: "modifyObject";
  readonly objectType: string;
  readonly objectReference: ValueSource;
  readonly properties: Readonly<Record<string, ValueSource>>;
}

export interface ModifyOrCreateObjectRule {
  readonly type: "modifyOrCreateObject";
  readonly objectType: string;
  readonly objectReference: ValueSource;
  readonly properties: Readonly<Record<string, ValueSource>>;
}

export interface DeleteObjectRule {
  readonly type: "deleteObject";
  readonly objectType: string;
  readonly objectReference: ValueSource;
}

// ---------------------------------------------------------------------------
// Concrete link rules (Add link / Delete link)
//
// Persistence uses the canonical `linkType` field (the link type's apiName).
// The legacy `linkTypeApiName` field is accepted on input only as an alias
// for `linkType` so the 24 seeded addLink actions and any pre-canonical data
// keep validating. New code MUST emit `linkType`.
// ---------------------------------------------------------------------------

export type LinkOperation = "addLink" | "removeLink";

export interface AddLinkRule {
  readonly type: "addLink";
  /** Canonical: link-type apiName. */
  readonly linkType: string;
  readonly sourceObject: ValueSource;
  readonly targetObject: ValueSource;
}

export interface RemoveLinkRule {
  readonly type: "removeLink";
  readonly linkType: string;
  readonly sourceObject: ValueSource;
  readonly targetObject: ValueSource;
}

// ---------------------------------------------------------------------------
// Interface-link rules (Phase 2 runtime; Phase 1 only persists the schema)
//
// An interface-link rule references an `interface_link_constraint` row, NOT
// a concrete link type. The runtime resolver finds the concrete link type(s)
// implemented for the resolved source/target object types, applies
// authorization, and — for creation — fails when resolution is ambiguous
// (more than one concrete link type satisfies the constraint). For removal,
// every matching concrete implementation is deleted (deterministic, audited).
// ---------------------------------------------------------------------------

export type InterfaceLinkOperation = "createInterfaceLink" | "deleteInterfaceLink";

export interface CreateInterfaceLinkRule {
  readonly type: "createInterfaceLink";
  /** apiName of the interface link constraint. */
  readonly interfaceLinkConstraint: string;
  /** Interface that owns the constraint (apiName). */
  readonly interfaceId: string;
  readonly source: ValueSource;
  readonly target: ValueSource;
}

export interface DeleteInterfaceLinkRule {
  readonly type: "deleteInterfaceLink";
  readonly interfaceLinkConstraint: string;
  readonly interfaceId: string;
  readonly source: ValueSource;
  readonly target: ValueSource;
}

// ---------------------------------------------------------------------------
// Rule union (discriminated on `type`)
// ---------------------------------------------------------------------------

export type ActionRule =
  | CreateObjectRule
  | ModifyObjectRule
  | ModifyOrCreateObjectRule
  | DeleteObjectRule
  | AddLinkRule
  | RemoveLinkRule
  | CreateInterfaceLinkRule
  | DeleteInterfaceLinkRule;

/** Every rule discriminator — enforced by a DB CHECK in migration 126. */
export const ACTION_RULE_DISCRIMINATORS = [
  "createObject",
  "modifyObject",
  "modifyOrCreateObject",
  "deleteObject",
  "addLink",
  "removeLink",
  "createInterfaceLink",
  "deleteInterfaceLink",
] as const;

export type ActionRuleDiscriminator = (typeof ACTION_RULE_DISCRIMINATORS)[number];

// ---------------------------------------------------------------------------
// Webhook — governed, registered resource referenced by id + version
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type WebhookStatus = "draft" | "active" | "disabled";

export type SecretReferenceKind =
  /** Tellus secrets manager (project-level). */
  | "tellus_secret"
  /** Reference by name to an external secret manager; resolved at execution. */
  | "external_reference";

export interface SecretReference {
  readonly kind: SecretReferenceKind;
  /**
   * For `tellus_secret` — the secret's stable identifier in Tellus's secrets
   * manager. For `external_reference` — the configured mount id. Plaintext
   * values are NEVER persisted in any rule, side effect, or webhook row.
   */
  readonly ref: string;
  /** Optional: key inside the referenced secret store (e.g. `"api_token"`). */
  readonly key?: string;
}

export interface GovernedEndpointReference {
  /** Fully-qualified URL. Production: MUST be HTTPS; dev-only flag permits HTTP. */
  readonly url: string;
  /** Disable redirects by default; revalidate each hop when enabled. */
  readonly followRedirects?: boolean;
  /** Optional explicit allowlist of hosts (defence in depth on top of DNS). */
  readonly allowedHosts?: ReadonlyArray<string>;
  /** Inbound/outbound header allowlist; hop-by-hop headers always stripped. */
  readonly headerAllowlist?: ReadonlyArray<string>;
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly multiplier: number;
  readonly jitterMs: number;
}

export interface WebhookDefinition {
  readonly id: string;
  readonly ontologyId: string;
  readonly name: string;
  readonly description?: string;
  readonly version: number;
  readonly status: WebhookStatus;
  readonly method: HttpMethod;
  readonly endpointConfig: GovernedEndpointReference;
  /** JSON Schema (draft 2020-12) for the webhook request body. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Optional JSON Schema for the webhook response body. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Authentication materialised from a SecretReference — never plaintext. */
  readonly authenticationConfig: SecretReference;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly retryPolicy?: RetryPolicy;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Writeback — pre-edit stage (Phase 4 runtime; schema in Phase 1)
// ---------------------------------------------------------------------------

/**
 * Output binding: declares how a field of the writeback response is exposed
 * as a typed value source for later rules.
 *
 *   outputId  — stable identifier within the webhook's outputSchema (the
 *               `outputId` the `WritebackResponseValueSource.outputId`
 *               references later).
 *   path      — JSONPointer into the response body.
 *   schema    — local sub-schema the path's value MUST conform to; the
 *               validator coerces only via the centralized ontology coercion.
 *   valueType — the ontology base type this resolves to (string|long|...);
 *               save-time-validated against the consuming rule's parameter
 *               type.
 */
export interface WritebackOutputDefinition {
  readonly outputId: string;
  readonly path: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly valueType: string;
}

export interface ActionWritebackConfig {
  readonly webhookId: string;
  readonly webhookVersion: number;
  /** Input name → ValueSource. Each input validated against webhook.inputSchema at save+exec time. */
  readonly inputs: Readonly<Record<string, ValueSource>>;
  readonly outputBindings?: Readonly<Record<string, WritebackOutputDefinition>>;
  /**
   * Only `"abort"` is supported today. On failure: ontology edits are NOT
   * applied; side effects are NOT enqueued; user-visible sanitized error.
   */
  readonly failurePolicy: "abort";
}

// ---------------------------------------------------------------------------
// Side effects — durable outbox (Phase 5 worker; schema in Phase 1)
//
// Persistence shape. The request-path code in Phase 5 inserts these rows in
// the SAME transaction as the ontology edit commit. The worker later claims
// and dispatches them via the registered NotificationProvider / Webhook
// transport.
// ---------------------------------------------------------------------------

export type SideEffectKind = "webhook" | "notification";

export interface WebhookSideEffectConfig {
  readonly kind: "webhook";
  readonly webhookId: string;
  readonly webhookVersion: number;
  readonly inputs: Readonly<Record<string, ValueSource>>;
}

export type NotificationChannel = "in_app" | "email" | "slack_compatible";

export interface NotificationRecipient {
  /** Stable principal id (user or group). */
  readonly principal: string;
  readonly principalKind: "user" | "group";
}

export interface NotificationSideEffectConfig {
  readonly kind: "notification";
  readonly channel: NotificationChannel;
  readonly recipients: ReadonlyArray<NotificationRecipient>;
  /** Rendered from a template — see NotificationTemplate. */
  readonly templateId: string;
  /** Per-template parameters (validated against the template schema). */
  readonly templateParameters: Readonly<Record<string, ValueSource>>;
}

export type ActionSideEffectConfig = WebhookSideEffectConfig | NotificationSideEffectConfig;

// ---------------------------------------------------------------------------
// Discriminated helper — exhaustiveness checks
// ---------------------------------------------------------------------------

export function assertNever(value: never): never {
  throw new Error(`Internal: unhandled discriminant ${JSON.stringify(value)}`);
}
