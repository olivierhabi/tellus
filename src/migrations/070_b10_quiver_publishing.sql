-- =============================================================================
-- 070 — Quiver B10: Dashboards, Visual Functions, Templates (legacy)
-- =============================================================================
-- Three publish surfaces stored as parallel relational tables, each with an
-- immutable version row + ETag + branch column. Schemas mirror Compass
-- conventions (rid PK + parent_folder_rid + display_name + etag +
-- created_at/updated_at).
-- =============================================================================

CREATE TABLE IF NOT EXISTS quiver_dashboard (
    rid TEXT PRIMARY KEY,
    parent_folder_rid TEXT NOT NULL,
    analysis_rid TEXT NOT NULL,
    display_name TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'master',
    exposed_canvases JSONB NOT NULL DEFAULT '[]'::jsonb,
    parameter_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
    current_version INTEGER NOT NULL DEFAULT 1,
    etag TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quiver_dashboard_parent
    ON quiver_dashboard (parent_folder_rid);
CREATE INDEX IF NOT EXISTS idx_quiver_dashboard_analysis
    ON quiver_dashboard (analysis_rid);

CREATE TABLE IF NOT EXISTS quiver_dashboard_version (
    rid TEXT NOT NULL REFERENCES quiver_dashboard(rid) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    snapshot JSONB NOT NULL,
    parameter_schema JSONB NOT NULL,
    branch TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_by TEXT NOT NULL,
    PRIMARY KEY (rid, version)
);

CREATE TABLE IF NOT EXISTS quiver_dashboard_embed (
    embed_id TEXT PRIMARY KEY,
    dashboard_rid TEXT NOT NULL REFERENCES quiver_dashboard(rid) ON DELETE CASCADE,
    surface TEXT NOT NULL CHECK (surface IN ('OBJECT_VIEW', 'WORKSHOP')),
    target_rid TEXT NOT NULL,
    param_bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quiver_dashboard_embed_dashboard
    ON quiver_dashboard_embed (dashboard_rid);
CREATE INDEX IF NOT EXISTS idx_quiver_dashboard_embed_target
    ON quiver_dashboard_embed (target_rid);

CREATE TABLE IF NOT EXISTS quiver_visual_function (
    rid TEXT PRIMARY KEY,
    parent_folder_rid TEXT NOT NULL,
    analysis_rid TEXT NOT NULL,
    display_name TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'master',
    exposed_parameter_card_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    root_card_id TEXT NOT NULL,
    input_schema JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_type TEXT NOT NULL,
    current_version INTEGER NOT NULL DEFAULT 1,
    etag TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quiver_visual_function_parent
    ON quiver_visual_function (parent_folder_rid);

CREATE TABLE IF NOT EXISTS quiver_visual_function_version (
    rid TEXT NOT NULL REFERENCES quiver_visual_function(rid) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    sub_dag JSONB NOT NULL,
    input_schema JSONB NOT NULL,
    output_type TEXT NOT NULL,
    branch TEXT NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_by TEXT NOT NULL,
    PRIMARY KEY (rid, version)
);

-- Templates (legacy): kept for one release per spec. Deprecation/Sunset
-- headers are applied at the route layer.
CREATE TABLE IF NOT EXISTS quiver_template (
    rid TEXT PRIMARY KEY,
    parent_folder_rid TEXT NOT NULL,
    display_name TEXT NOT NULL,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL
);
