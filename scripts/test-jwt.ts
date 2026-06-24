import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import "dotenv/config";

const KC_JWKS_URL = "http://localhost:8086/realms/tellus/protocol/openid-connect/certs";

const client = jwksClient({
  jwksUri: KC_JWKS_URL,
});

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, function (err, key) {
    if (err || !key) return callback(err);
    const signingKey = key.getPublicKey();
    callback(null, signingKey);
  });
}

// Emulate exactly how the server gets the token:
const token = process.argv[2];

const KC_ISSUER = "http://localhost:8086/realms/tellus";

jwt.verify(
  token,
  getSigningKey,
  {
    algorithms: ["RS256"],
    issuer: [
        KC_ISSUER,
        `http://localhost:8086/realms/tellus`,
        `http://keycloak:8086/realms/tellus`
    ],
  },
  (err, decoded) => {
    if (err) {
      console.error("VERIFY ERROR:", err.name, "-", err.message);
    } else {
      console.log("Successfully Decoded:", decoded);
    }
  }
);
