BEGIN;
DELETE FROM tpa_long_lived_tokens    WHERE application_id IN ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e', '78a604f5-dd8f-4dd7-863c-43374f7b9558', '5b14b20b-cd0b-433b-94e5-8c2e564e4eaa', 'c865258f-3d4e-4e92-935c-43b1dc1497eb')::uuid;
DELETE FROM tpa_project_grants       WHERE application_id IN ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e', '78a604f5-dd8f-4dd7-863c-43374f7b9558', '5b14b20b-cd0b-433b-94e5-8c2e564e4eaa', 'c865258f-3d4e-4e92-935c-43b1dc1497eb')::uuid;
DELETE FROM tpa_operation_scopes     WHERE application_id IN ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e', '78a604f5-dd8f-4dd7-863c-43374f7b9558', '5b14b20b-cd0b-433b-94e5-8c2e564e4eaa', 'c865258f-3d4e-4e92-935c-43b1dc1497eb')::uuid;
DELETE FROM tpa_application_members  WHERE application_id IN ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e', '78a604f5-dd8f-4dd7-863c-43374f7b9558', '5b14b20b-cd0b-433b-94e5-8c2e564e4eaa', 'c865258f-3d4e-4e92-935c-43b1dc1497eb')::uuid;
DELETE FROM tpa_ontology_resources  WHERE application_id IN ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e', '78a604f5-dd8f-4dd7-863c-43374f7b9558', '5b14b20b-cd0b-433b-94e5-8c2e564e4eaa', 'c865258f-3d4e-4e92-935c-43b1dc1497eb')::uuid;
DELETE FROM tpa_redirect_uris        WHERE application_id IN ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e', '78a604f5-dd8f-4dd7-863c-43374f7b9558', '5b14b20b-cd0b-433b-94e5-8c2e564e4eaa', 'c865258f-3d4e-4e92-935c-43b1dc1497eb')::uuid;
DELETE FROM third_party_applications WHERE id      IN ('8c20bd7e-1a39-4878-89f8-fc30ccc2f41e', '78a604f5-dd8f-4dd7-863c-43374f7b9558', '5b14b20b-cd0b-433b-94e5-8c2e564e4eaa', 'c865258f-3d4e-4e92-935c-43b1dc1497eb')::uuid;
COMMIT;
