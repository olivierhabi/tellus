-- ---------------------------------------------------------------------------
-- Migration 173: action_type.security_settings — the non-criteria half of the
-- Ontology Manager "Security & Submission Criteria" page.
--
-- The page authors seven cards. Save location, submission criteria, permission
-- breakdown and branch protection all read/write existing state
-- (save_location_rid, submission_criteria, the ontology's branches). The
-- remaining three had nowhere to live:
--
--   * Testing on branches   — may webhooks / external-call functions /
--                             notifications fire when this action runs on a
--                             non-main branch? Default OFF for all three:
--                             a branch is a rehearsal, and firing a real
--                             webhook or emailing real users from a rehearsal
--                             is the failure mode these switches exist to
--                             prevent. Enforced in actionExecutor's
--                             post-commit side-effect stage.
--   * Frontend consumers    — may Automate submit this action? Default ON
--                             (matches Foundry, and every existing automation
--                             keeps working after this migration).
--                             Enforced in services/automate/runtime.ts.
--   * Notification settings — actionFailurePolicy 'all' (default) fails the
--                             action when any notified user cannot see an
--                             edited object; 'any' proceeds as long as one
--                             can. disableNotificationRedaction lets the
--                             whole org see unredacted notifications.
--                             Read by the side-effect worker's recipient
--                             visibility filter.
--
-- Stored as one JSONB blob rather than six columns: it is a single cohesive
-- settings object read together by one page, and a blob keeps future Foundry
-- toggles from needing a migration each.
--
-- Deliberately NOT added to the trg_action_type_definition_version watch list
-- or the canonical definition hash. These are deployment/operational policy,
-- not action SEMANTICS: flipping "allow notifications on branches" does not
-- change what parameters an action takes or what edits it makes, so it must
-- not invalidate Automate pins that reference this action type. Contrast
-- submission_criteria, which IS watched, because who may submit is semantics.
-- ---------------------------------------------------------------------------

ALTER TABLE action_type
  ADD COLUMN IF NOT EXISTS security_settings JSONB NULL;

COMMENT ON COLUMN action_type.security_settings IS
  'Ontology Manager Security page operational settings: { allowWebhooksOnBranches, allowExternalCallFunctionsOnBranches, allowNotificationsOnBranches, allowAutomateSubmission, actionFailurePolicy: "all"|"any", disableNotificationRedaction }. NULL = every default (branch side effects off, Automate allowed, failure policy "all", redaction on). NOT part of the definition hash or version-bump trigger — operational policy, not action semantics.';

-- Shape guard. A malformed blob would otherwise be read by the executor's
-- branch-side-effect gate, where an unexpected type silently reads as
-- "not true" and quietly disables side effects with no diagnostic.
ALTER TABLE action_type
  DROP CONSTRAINT IF EXISTS action_type_security_settings_shape_chk;
ALTER TABLE action_type
  ADD CONSTRAINT action_type_security_settings_shape_chk CHECK (
    security_settings IS NULL
    OR (
      jsonb_typeof(security_settings) = 'object'
      AND (NOT security_settings ? 'allowWebhooksOnBranches'
           OR jsonb_typeof(security_settings -> 'allowWebhooksOnBranches') = 'boolean')
      AND (NOT security_settings ? 'allowExternalCallFunctionsOnBranches'
           OR jsonb_typeof(security_settings -> 'allowExternalCallFunctionsOnBranches') = 'boolean')
      AND (NOT security_settings ? 'allowNotificationsOnBranches'
           OR jsonb_typeof(security_settings -> 'allowNotificationsOnBranches') = 'boolean')
      AND (NOT security_settings ? 'allowAutomateSubmission'
           OR jsonb_typeof(security_settings -> 'allowAutomateSubmission') = 'boolean')
      AND (NOT security_settings ? 'disableNotificationRedaction'
           OR jsonb_typeof(security_settings -> 'disableNotificationRedaction') = 'boolean')
      AND (NOT security_settings ? 'actionFailurePolicy'
           OR security_settings ->> 'actionFailurePolicy' IN ('all', 'any'))
    )
  );
