### Name

Quiver editor production UI

### Context

The `/quiver` frontends are already merged: `/quiver` redirects to a wired analyses list, and `/quiver/analyses/[rid]` wraps the polished workbench chrome around the real wired views with optimistic OT submit, WS collab, and live DAG validation. What remains "thin" is the interactive surface a reviewer (Codex) will exercise first:

- **Version history is dead code.** `HistoryDialog` is hard-wired closed (`useQuiverStore((s) => false)`) and references a non-existent field `v.versionNumber` (the wire type `AnalysisVersion` has `versionRid` / `named` / `message`, no `versionNumber`). The History button only shows a "coming soon" toast. So the fully-plumbed `useVersions` / `useRevertToVersion` hooks are unreachable.
- **Parameter & formula cards are read-only.** Every `PARAMETER_*` plugin renders a disabled/`readOnly` input even though the `updateCardConfig` instruction and the optimistic submit path exist. Foundry Quiver's defining feature is interactive parameter views; today none of them write back.
- **Compute outputs degrade to raw JSON.** Several compute-backed plugins (`FILTER_OBJECT_SET`, `SEARCH_AROUND`, `PROPERTY_VALUE_SELECT`, `MATERIALIZATION`, `FUNCTION_CALL`) dump `KeyValuePreview` JSON instead of a structured table, despite `ObjectSetTable` being available.

These three are fully wired at the data layer — only the UI is missing. Fixing them makes the editor demonstrably interactive end-to-end. Genuinely backend-blocked items (ontology object sea
