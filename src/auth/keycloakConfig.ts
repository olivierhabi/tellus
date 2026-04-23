// ---------------------------------------------------------------------------
// F-P4-26 — Centralised Keycloak realm / issuer accessors.
//
// Eight call sites used to read `process.env.KEYCLOAK_REALM || 'tellus'`
// independently. That created two failure modes in production:
//   1. A mis-spelled env var silently fell back to the well-known dev
//      realm name 'tellus'. If a misconfigured pod ever pointed at a
//      multi-realm Keycloak, it could authenticate against the wrong
//      realm and accept tokens from it.
//   2. Rotating the realm required editing eight files.
//
// This module is the single source of truth. Production mode
// (`NODE_ENV=production`) fail-closes via `requireEnv`; non-production
// keeps the 'tellus' dev fallback so docker-compose bring-up works
// without explicit wiring. `requireEnv` only kicks in when the realm is
// actually read, so module-load order stays safe.
// ---------------------------------------------------------------------------

import { envWithDefault, requireEnv } from "../utils/requireEnv";

const DEV_REALM = "tellus";

/**
 * Returns the Keycloak realm name.
 * - Production (NODE_ENV=production): throws MissingEnvError if
 *   KEYCLOAK_REALM is unset. No silent 'tellus' fallback.
 * - Dev/test: falls back to 'tellus' for docker-compose compatibility.
 */
export function getKeycloakRealm(): string {
  if (envWithDefault("NODE_ENV", "development") === "production") {
    return requireEnv("KEYCLOAK_REALM", "Keycloak realm is required in production.");
  }
  return envWithDefault("KEYCLOAK_REALM", DEV_REALM);
}

/**
 * Returns the Keycloak base URL. Production fail-closed; dev falls back
 * to localhost:8086.
 */
export function getKeycloakBaseUrl(): string {
  if (envWithDefault("NODE_ENV", "development") === "production") {
    return requireEnv("KEYCLOAK_BASE_URL", "KEYCLOAK_BASE_URL is required in production.");
  }
  return envWithDefault("KEYCLOAK_BASE_URL", "http://localhost:8086");
}

/**
 * Convenience combinator: the OIDC issuer URL for the current realm.
 */
export function getKeycloakIssuer(): string {
  return `${getKeycloakBaseUrl().replace(/\/$/, "")}/realms/${getKeycloakRealm()}`;
}
