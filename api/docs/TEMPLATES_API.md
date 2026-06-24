# Templates API (B3)

**Mount prefix:** *(not mounted on the live server — available as a module)*
**Status:** **Module-ready** — `createTemplatesAdminApp({ pool })` from `src/services/templates/admin/app.ts`. Wire by adding `app.use("/api/v1/templates", createTemplatesAdminApp({ pool }))` to `src/server.ts`.
**Source:** `src/services/templates/`
**Migrations applied:** `056_b3_templates`.

The Templates service is a deterministic scaffold engine for new repositories.
Five v1 templates are available as TS literals (`typescript-functions`,
`python-functions`, `transforms-python`, `transforms-java`, `transforms-sql`).
Scaffolds are deterministic — same `(templateId, templateVersion, parameters)`
always produces the same file set and the same content sha256.

## Endpoints

### `GET /templates`

Lists every available template with its versions.

```json
{
  "items": [
    {
      "templateId":   "typescript-functions",
      "displayName":  "TypeScript Functions",
      "description":  "Authoring template for typed functions (B8 publish target)",
      "versions":     [ "2.4.0", "2.3.1" ],
      "parameters":   [
        { "name": "packageName", "regex": "^[a-z][a-z0-9-]{0,63}$", "description": "npm package name" }
      ]
    },
    /* python-functions, transforms-{python,java,sql} */
  ]
}
```

### `GET /templates/:id/versions/:version`

Returns the manifest for a specific `(templateId, templateVersion)`. Manifest
shape:

```json
{
  "templateId":      "typescript-functions",
  "templateVersion": "2.4.0",
  "parameters":      [
    { "name": "packageName", "regex": "^[a-z][a-z0-9-]{0,63}$" }
  ],
  "files": [
    { "path": "package.json",     "content": "{...}",       "sha256": "0123…" },
    { "path": "src/index.ts",     "content": "export …",    "sha256": "abcd…" },
    { "path": "tsconfig.json",    "content": "{...}",       "sha256": "ef01…" }
  ],
  "commitMessage": "Initial commit from {templateId}@{templateVersion}",
  "metadataFiles": [ ".tellus/template.lock.json" ]
}
```

Unknown id or version → 404 `Templates:NotFound`.

### `POST /scaffold`

Render a template against caller parameters. Idempotency-required.

```http
POST /api/v1/templates/scaffold
Idempotency-Key: <uuid>
Content-Type: application/json

{
  "templateId":      "typescript-functions",
  "templateVersion": "2.4.0",
  "parameters":      { "packageName": "data-pipelines" }
}
```

**200 OK**

```json
{
  "files": [
    { "path": "package.json",  "content": "{...}",     "sha256": "…" }
    /* …all template files with parameters substituted */
  ],
  "commitSha":     "0123abcd…",
  "commitMessage": "Initial commit from typescript-functions@2.4.0"
}
```

`commitSha` is `sha256(canonicalised file list)` — deterministic across runs.
A second call with identical parameters produces the byte-identical commit sha.

If a parameter is missing, the engine derives it from a hint
(`deriveFromRepoName`) where possible, falling back to a default value
prescribed by the template manifest.

## Validation rules

- `parameters[*].value` must satisfy each parameter's `regex`.
- `parameters[*]` value derivation honors the regex — if the regex permits
  hyphens, hyphens are used as the word separator; otherwise underscores.
  Example: `python-functions` `packageName` regex is `^[a-z][a-z0-9_]{0,63}$`,
  so `My Repo` derives to `my_repo`. `typescript-functions` regex is
  `^[a-z][a-z0-9-]{0,63}$`, so `My Repo` derives to `my-repo`.

## Error names

| `errorName` | HTTP | When |
|---|---|---|
| `Templates:NotFound` | 404 | Unknown id or version. |
| `Templates:InvalidParameters` | 400 | Parameter regex mismatch. |
| `Templates:ParametersIncomplete` | 400 | Required parameter missing and no derivation hint. |
| `Templates:Internal` | 500 | Unexpected. |
| `Templates:Unauthenticated` | 401 | Missing principal. |

## Schema highlights (migration 056)

The DDL is a thin index for catalog discovery; the actual template content
lives in TS source under `src/services/templates/manifest.ts`.

- `templates_index (template_id, template_version, manifest_sha256, registered_at)`

## Test coverage

- `tests/unit/code-repos/templates/scaffold-unit.test.ts` — 19 cases
- `tests/unit/code-repos/templates/errors-unit.test.ts` — 7 cases
- `tests/integration/code-repos/templates/admin-routes-integration.test.ts` — 20 cases

## Spec acceptance verified

`typescript-functions@2.4.0` with `{ packageName: "data-pipelines" }` returns
identical `commitSha` across two consecutive scaffold runs (verified by
`scaffold-unit.test.ts > spec acceptance §1: deterministic commit sha`).
