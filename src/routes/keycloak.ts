/**
 * /api/v2/sso — routes that exercise the Keycloak integration end-to-end.
 *
 * Adds three endpoints used by the Cypress + bash test layers:
 *
 *   GET  /api/v2/sso/config   — public, returns the Keycloak realm metadata
 *                              the frontend needs to bootstrap its login form
 *   GET  /api/v2/sso/whoami   — protected, requires a valid Keycloak token,
 *                              returns the verified claims
 *   GET  /api/v2/sso/admin    — protected + role-gated, requires the
 *                              `ontology-admin` realm role
 */

import { Router, type Request, type Response } from "express";
import { keycloakAuth } from "../middleware/keycloakAuth";

const router = Router();

const KC_URL = process.env.KEYCLOAK_URL || "http://localhost:8086";
const KC_REALM = process.env.KEYCLOAK_REALM || "tellus";
const KC_FRONTEND_CLIENT =
  process.env.KEYCLOAK_FRONTEND_CLIENT_ID || "tellus-frontend";

router.get("/sso/config", (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      enabled: !!KC_URL,
      url: KC_URL,
      realm: KC_REALM,
      clientId: KC_FRONTEND_CLIENT,
      tokenEndpoint: `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/token`,
      jwksUri: `${KC_URL}/realms/${KC_REALM}/protocol/openid-connect/certs`,
      issuer: `${KC_URL}/realms/${KC_REALM}`,
    },
  });
});

router.get("/sso/whoami", keycloakAuth(), (req: Request, res: Response) => {
  const u = req.keycloakUser!;
  res.json({
    success: true,
    data: {
      sub: u.sub,
      email: u.email,
      preferredUsername: u.preferred_username,
      realmRoles: u.realm_access?.roles ?? [],
      issuer: u.iss,
      issuedAt: new Date(u.iat * 1000).toISOString(),
      expiresAt: new Date(u.exp * 1000).toISOString(),
    },
  });
});

router.get(
  "/sso/admin",
  keycloakAuth({ requiredRole: "ontology-admin" }),
  (req: Request, res: Response) => {
    res.json({
      success: true,
      data: {
        message: "you have ontology-admin",
        sub: req.keycloakUser!.sub,
      },
    });
  },
);

export default router;
