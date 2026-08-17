-- ---------------------------------------------------------------------------
-- Migration 172: Developer Console demo — four rwanda-qa scenario client
-- apps, each tied to a workshop module UUID.
--
--   Scenario A — BK Credit Risk Workbench         /workshop/ri.workshop.main.module.8c20bd7e-1a39-4878-89f8-fc30ccc2f41e/view
--   Scenario B — Irembo Land Transfer Desk        /workshop/ri.workshop.main.module.78a604f5-dd8f-4dd7-863c-43374f7b9558/view
--   Scenario C — RSwitch Payment Exception Cmd    /workshop/ri.workshop.main.module.5b14b20b-cd0b-433b-94e5-8c2e564e4eaa/view
--   Scenario D — Pindo Carrier Reliability Ops    /workshop/ri.workshop.main.module.c865258f-3d4e-4e92-935c-43b1dc1497eb/view
--
-- The standalone Next.js client in ../developer-console-demo fetches each
-- app's developer-console manifest (oauth + ontology-sdk + platform-sdk)
-- from `/api/v1/developer-console/applications/<rid>` and renders a real
-- client dashboard — every object type, action, parameter, scope, and
-- projection is discovered at runtime from the developer-console surface.
-- ---------------------------------------------------------------------------

-- 1. Third-party-app rows ------------------------------------------------------
INSERT INTO third_party_applications (
  id, rid, name, description, client_id, client_type, organization_name,
  organization_count, location_path, project_name, project_rid,
  creator_id, creator_name, last_edited_by, resource_restrictions,
  operation_restrictions, marking_restrictions, permission_mode,
  application_types, grant_types
)
SELECT
  app.uuid,
  'ri.third-party-applications.main.application.' || app.uuid::text,
  app.name,
  app.description,
  replace(app.uuid::text, '-', ''),
  'confidential',
  'Tellus Rwanda',
  1,
  app.location_path,
  app.name,
  'ri.compass.main.project.' || app.uuid::text,
  'system',
  'workshop-import',
  'workshop-import',
  'restricted',
  'restricted',
  'restricted',
  'application',
  ARRAY['client-facing', 'backend-service'],
  ARRAY['client_credentials', 'authorization_code']
FROM (VALUES
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'BK Credit Risk Workbench',           'Scenario A client app from rwanda-qa; approves credit limits.',         '/tellus-rwanda/a-bk-workbench'),
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, 'Irembo Land Transfer Desk',          'Scenario B client app; land officer & supervisor override.',           '/tellus-rwanda/b-irembo-desk'),
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, 'RSwitch Payment Exception Command',  'Scenario C client app; reconcile failed payment exceptions.',          '/tellus-rwanda/c-rswitch-command'),
  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid, 'Pindo Carrier Reliability Ops',      'Scenario D client app; manual failover of unhealthy routes.',          '/tellus-rwanda/d-pindo-ops')
) AS app(uuid, name, description, location_path)
WHERE NOT EXISTS (SELECT 1 FROM third_party_applications t WHERE t.id = app.uuid);

-- 2. OAuth redirect URIs (demo client runs at http://localhost:3002) -----------
INSERT INTO tpa_redirect_uris (application_id, uri)
SELECT app.uuid, uri
FROM (VALUES
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'http://localhost:3002/a/auth/callback'),
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, 'http://localhost:3002/b/auth/callback'),
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, 'http://localhost:3002/c/auth/callback'),
  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid, 'http://localhost:3002/d/auth/callback')
) AS app(uuid, uri)
WHERE NOT EXISTS (
  SELECT 1 FROM tpa_redirect_uris r WHERE r.application_id = app.uuid AND r.uri = app.uri
);

-- 3. Ontology-SDK resources per app (object type + action type) ----------------
-- Metadata carries properties (for object types) and parameters (for actions),
-- plus the action's submission-criteria so the demo client can render gated
-- action buttons and projection-aware object tables.

INSERT INTO tpa_ontology_resources (
  application_id, kind, api_name, display_name, icon_json, status,
  parent_api_name, has_no_resources, sort_order, metadata
)
SELECT app_uuid, kind, api_name, display_name, icon_json::jsonb, 'active',
       NULL, FALSE, sort_order, metadata::jsonb
FROM (VALUES
  -- Scenario A — BK Credit Risk
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'object_type', 'QaRwBkLoanApplications', 'Loan Application', '{"icon":"CUBE","color":"#4C90F0","bg":"rgb(236,243,253)","border":"rgb(184,211,249)"}',
    0, '{"primaryKey":"applicationId","properties":[{"apiName":"applicationId","primary_key":true,"fieldType":"string","display":"Application ID"},{"apiName":"applicantName","fieldType":"string","display":"Applicant","marking":"PII_ID"},{"apiName":"requestedLimit","fieldType":"number","display":"Requested Limit","marking":"FINANCIAL_DETAIL"},{"apiName":"assignedAnalyst","fieldType":"string","display":"Analyst"},{"apiName":"status","fieldType":"string","display":"Status"}],"filters":{"status":["SUBMITTED","UNDER_REVIEW","APPROVED","ESCALATED","DOCS_REQUESTED"],"assignedAnalyst":[]},"actions":["qaRwBkApproveCreditLimit","qaRwBkEscalateForReview","qaRwBkRequestMoreDocuments"]}'),
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'action_type', 'qaRwBkApproveCreditLimit', 'Approve Credit Limit', '{"icon":"EDIT","color":"#FFFFFF","bg":"rgb(17,20,24)","border":"rgb(14,17,20)"}',
    1, '{"parameters":[{"name":"applicationId","fieldType":"string","required":true},{"name":"decisionId","fieldType":"string","required":true},{"name":"approvedLimit","fieldType":"number","required":true},{"name":"rationale","fieldType":"string","required":false},{"name":"approver","fieldType":"string","required":false}],"submissionCriteria":[{"type":"objectCondition","objectType":"QaRwBkLoanApplications","property":"status","operator":"in","values":["UNDER_REVIEW"]},{"type":"role","role":"credit-analyst","description":"Only credit analysts may approve."}],"requiresMarkings":["CREDIT_RISK","FINANCIAL_DETAIL"]}'),
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'action_type', 'qaRwBkEscalateForReview', 'Escalate For Review', '{"icon":"EDIT","color":"#FFFFFF","bg":"rgb(17,20,24)","border":"rgb(14,17,20)"}',
    2, '{"parameters":[{"name":"applicationId","fieldType":"string","required":true},{"name":"reason","fieldType":"string","required":false}],"submissionCriteria":[{"type":"objectCondition","objectType":"QaRwBkLoanApplications","property":"status","operator":"in","values":["SUBMITTED"]}],"requiresMarkings":["CREDIT_RISK"]}'),
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'action_type', 'qaRwBkRequestMoreDocuments', 'Request More Documents', '{"icon":"EDIT","color":"#FFFFFF","bg":"rgb(17,20,24)","border":"rgb(14,17,20)"}',
    3, '{"parameters":[{"name":"applicationId","fieldType":"string","required":true},{"name":"note","fieldType":"string","required":false}],"submissionCriteria":[{"type":"objectCondition","objectType":"QaRwBkLoanApplications","property":"status","operator":"in","values":["SUBMITTED","UNDER_REVIEW"]}],"requiresMarkings":["PII_ID"]}'),

  -- Scenario B — Irembo Land Transfer
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, 'object_type', 'QaRwIremboLandTransferCases', 'Land Transfer Case', '{"icon":"CUBE","color":"#4C90F0","bg":"rgb(236,243,253)","border":"rgb(184,211,249)"}',
    0, '{"primaryKey":"caseId","properties":[{"apiName":"caseId","primary_key":true,"fieldType":"string","display":"Case ID"},{"apiName":"applicantNationalId","fieldType":"string","display":"Applicant","marking":"PII_ID"},{"apiName":"source","fieldType":"string","display":"Source"},{"apiName":"sourceStale","fieldType":"boolean","display":"Source Stale"},{"apiName":"status","fieldType":"string","display":"Status"}],"filters":{"status":["APPROVAL_PENDING","COMPLETED","REJECTED","OVERRIDE_PENDING"],"sourceStale":[true,false]},"actions":["qaRwIremboApproveTransfer","qaRwIremboRejectTransfer","qaRwIremboOverrideException"]}'),
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, 'action_type', 'qaRwIremboApproveTransfer', 'Approve Land Transfer', '{"icon":"EDIT","color":"#FFFFFF","bg":"rgb(17,20,24)","border":"rgb(14,17,20)"}',
    1, '{"parameters":[{"name":"caseId","fieldType":"string","required":true},{"name":"historyId","fieldType":"string","required":true},{"name":"note","fieldType":"string","required":false}],"submissionCriteria":[{"type":"objectCondition","objectType":"QaRwIremboLandTransferCases","property":"status","operator":"in","values":["APPROVAL_PENDING"]},{"type":"objectCondition","objectType":"QaRwIremboLandTransferCases","property":"sourceStale","operator":"eq","value":false,"description":"Source document is stale"}],"requiresMarkings":["PII_ID"]}'),
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, 'action_type', 'qaRwIremboOverrideException', 'Override Exception', '{"icon":"EDIT","color":"#FFFFFF","bg":"rgb(17,20,24)","border":"rgb(14,17,20)"}',
    2, '{"parameters":[{"name":"caseId","fieldType":"string","required":true},{"name":"clearanceId","fieldType":"string","required":true},{"name":"reason","fieldType":"string","required":true},{"name":"evidence","fieldType":"string","required":true}],"submissionCriteria":[{"type":"role","role":"land-supervisor","description":"Only land supervisors may override."}],"requiresMarkings":["PII_ID"]}'),

  -- Scenario C — RSwitch Payment Exceptions
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, 'object_type', 'QaRwRswitchPaymentTransactions', 'RSwitch Payment Transaction', '{"icon":"CUBE","color":"#4C90F0","bg":"rgb(236,243,253)","border":"rgb(184,211,249)"}',
    0, '{"primaryKey":"transactionId","properties":[{"apiName":"transactionId","primary_key":true,"fieldType":"string","display":"Transaction ID"},{"apiName":"amount","fieldType":"number","display":"Amount","marking":"PUBLIC"},{"apiName":"bankCode","fieldType":"string","display":"Bank Code"},{"apiName":"status","fieldType":"string","display":"Status"},{"apiName":"reconciliationEligibility","fieldType":"string","display":"Eligibility"},{"apiName":"responseCode","fieldType":"string","display":"Response Code"},{"apiName":"pan","fieldType":"string","display":"PAN","marking":"PCI_PAN_MASKED"}],"filters":{"status":["FAILED","RECONCILED","PENDING"],"reconciliationEligibility":["ELIGIBLE","INELIGIBLE","DUPLICATE"],"bankCode":[]},"actions":["qaRwRswitchReconcileTransaction"]}'),
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, 'action_type', 'qaRwRswitchReconcileTransaction', 'Reconcile Transaction', '{"icon":"EDIT","color":"#FFFFFF","bg":"rgb(17,20,24)","border":"rgb(14,17,20)"}',
    1, '{"parameters":[{"name":"transactionId","fieldType":"string","required":true},{"name":"batchId","fieldType":"string","required":true},{"name":"reason","fieldType":"string","required":false}],"submissionCriteria":[{"type":"objectCondition","objectType":"QaRwRswitchPaymentTransactions","property":"status","operator":"in","values":["FAILED"]},{"type":"objectCondition","objectType":"QaRwRswitchPaymentTransactions","property":"reconciliationEligibility","operator":"in","values":["ELIGIBLE"]},{"type":"role","role":"recon-specialist","description":"Only reconciliation specialists may reconcile."}],"requiresMarkings":["PCI_PAN_MASKED"]}'),

  -- Scenario D — Pindo Carrier Reliability
  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid, 'object_type', 'QaRwPindoCarrierRoutes', 'Pindo Carrier Route', '{"icon":"CUBE","color":"#4C90F0","bg":"rgb(236,243,253)","border":"rgb(184,211,249)"}',
    0, '{"primaryKey":"routeId","properties":[{"apiName":"routeId","primary_key":true,"fieldType":"string","display":"Route ID"},{"apiName":"carrierName","fieldType":"string","display":"Carrier"},{"apiName":"state","fieldType":"string","display":"State"},{"apiName":"lastHealthCheck","fieldType":"string","display":"Last Health Check"}],"filters":{"state":["HEALTHY","UNHEALTHY","SWITCHED"],"carrierName":[]},"actions":["qaRwPindoSwitchCarrierRoute"]}'),
  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid, 'action_type', 'qaRwPindoSwitchCarrierRoute', 'Switch Carrier Route', '{"icon":"EDIT","color":"#FFFFFF","bg":"rgb(17,20,24)","border":"rgb(14,17,20)"}',
    1, '{"parameters":[{"name":"routeId","fieldType":"string","required":true},{"name":"targetRoute","fieldType":"string","required":true},{"name":"reason","fieldType":"string","required":false}],"submissionCriteria":[{"type":"objectCondition","objectType":"QaRwPindoCarrierRoutes","property":"state","operator":"in","values":["UNHEALTHY"]},{"type":"role","role":"ops-engineer","description":"Only ops engineers may switch routes."}]}')
) AS t(app_uuid, kind, api_name, display_name, icon_json, sort_order, metadata)
WHERE NOT EXISTS (
  SELECT 1 FROM tpa_ontology_resources r WHERE r.application_id = t.app_uuid AND r.kind = t.kind AND r.api_name = t.api_name
);

-- 4. Principal grants (organizer + per-scenario rwanda roles)
INSERT INTO tpa_application_members (application_id, tenant_id, principal_id, role, granted_by)
SELECT app_uuid, 'default', principal_id, role, 'workshop-import'
FROM (VALUES
  -- Organizer for all four apps (the demo's "ops" principal):
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, '00000000-0000-4000-9000-000000000101'::text, 'viewer'),
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, '00000000-0000-4000-9000-000000000102'::text, 'owner'),
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, '00000000-0000-4000-9000-000000000103'::text, 'owner'),
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, '00000000-0000-4000-9000-000000000104'::text, 'viewer'),
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, '00000000-0000-4000-9000-000000000105'::text, 'owner'),
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, '00000000-0000-4000-9000-000000000106'::text, 'owner'),
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, '00000000-0000-4000-9000-000000000108'::text, 'owner'),
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, '00000000-0000-4000-9000-000000000109'::text, 'viewer'),
  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid, '00000000-0000-4000-9000-000000000110'::text, 'owner'),
  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid, '00000000-0000-4000-9000-000000000111'::text, 'viewer')
) AS t(app_uuid, principal_id, role)
WHERE NOT EXISTS (
  SELECT 1 FROM tpa_application_members m
  WHERE m.application_id = t.app_uuid AND m.principal_id = t.principal_id
);

-- 5. Platform SDK operation scope allowlist + long-lived token seed, per app ---
INSERT INTO tpa_operation_scopes (application_id, scope, enabled)
SELECT app_uuid, scope, enabled
FROM (VALUES
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'api:use-ontologies-read'::text, true),
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'api:use-ontologies-write', true),
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'api:use-foundry-studio-read', true),
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'api:use-metrics-read', true),

  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, 'api:use-ontologies-read', true),
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, 'api:use-ontologies-write', true),
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, 'api:use-foundry-studio-read', true),

  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, 'api:use-ontologies-read', true),
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, 'api:use-ontologies-write', true),
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, 'api:use-foundry-studio-read', true),
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, 'api:use-metrics-read', true),

  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid, 'api:use-ontologies-read', true),
  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid, 'api:use-ontologies-write', true),
  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid, 'api:use-foundry-studio-read', true)
) AS t(app_uuid, scope, enabled)
WHERE NOT EXISTS (
  SELECT 1 FROM tpa_operation_scopes s
  WHERE s.application_id = t.app_uuid AND s.scope = t.scope
);

INSERT INTO tpa_project_grants (application_id, project_id, project_name, project_rid, description, icon_class, href)
SELECT app_uuid, 'rwanda-ops', 'Rwanda Operational Data Platform',
       'ri.compass.main.project.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
       'Source ontology for the Rwanda QA tier',
       'resource-icon__project__mypxcb', '/projects/rwanda-ops'
FROM (VALUES
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid),
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid),
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid),
  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid)
) AS t(app_uuid)
WHERE NOT EXISTS (
  SELECT 1 FROM tpa_project_grants g
  WHERE g.application_id = t.app_uuid AND g.project_id = 'rwanda-ops'
);

-- 6. Seed long-lived tokens (one per app, demo-only plaintext fingerprint) -----
-- Each app gets its OWN demo token — idx_tpa_tokens_hash is UNIQUE, so sharing
-- one token_hash across apps fails at insert. Plaintext demo token per app is
-- deterministic: plt_<uuid-hex>_<first-8-uuid-hex>
-- (e.g. Scenario A: plt_8c20bd7e1a39487889f8fc30ccc2f41e_8c20bd7e);
-- token_hash is the SHA-256 of that plaintext, exactly what the API verifies.
INSERT INTO tpa_long_lived_tokens (application_id, name, token_hash, token_prefix, scopes, expires_at, created_by)
SELECT app_uuid, t.name || ' (seed)', t.token_hash,
       'plt_' || left(replace(t.app_uuid::text, '-', ''), 8),
       '["api:use-ontologies-read","api:use-ontologies-write"]'::jsonb,
       now() + interval '90 days', 'workshop-import'
FROM (VALUES
  ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e'::uuid, 'BK Credit Risk Workbench',           '132cccba6c1def8ee25e1cabad0dceedbc013a7ecd2866909b5743a7ca124d3c'),
  ('78a604f5-dd8f-4dd7-863c-43374f7b9558'::uuid, 'Irembo Land Transfer Desk',          '318f49b8a977da252e5126f7fa640c2de7f3b40c13b01873836f4df36a699dac'),
  ('5b14b20b-cd0b-433b-94e5-8c2e564e4eaa'::uuid, 'RSwitch Payment Exception Command',  'f6d8a265cb0ff5e3935cf48faa83e6fc6126c28b0ca2aee318c006c67eaba30a'),
  ('c865258f-3d4e-4e92-935c-43b1dc1497eb'::uuid, 'Pindo Carrier Reliability Ops',      'e355a1d5bd011877221fb1263535aac6dfc066eb21661f4ec4f2e02c141f3767')
) AS t(app_uuid, name, token_hash)
WHERE NOT EXISTS (
  SELECT 1 FROM tpa_long_lived_tokens l WHERE l.application_id = t.app_uuid
);
