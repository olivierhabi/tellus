# Quiver Handoff Index

Machine-checkable inventory per CONTRACT v1 §6. Re-derived on every
verify run via `scripts/verify-handoff.sh`.

| path | sha256 | lines | purpose |
| ---- | ------ | ----- | ------- |
| docker-compose.verify.yml | 433535405c43ea9b8a12469cc9f4e060ce92d8babcd3202bef81f4bc01ab655e | 246 | dockerized verification stack |
| Dockerfile.verify | 35305e3ba478de448694617438427d36a80be53eb4523e8d377ae2079126272b | 44 | verify-only debian-slim runtime image (glibc; arm64-temporalio compat) |
| otel-collector-config.yaml | 732035c34e64a36c51a50c25052ce0fc104099720b793036c21c32a734004a88 | 58 | OTel collector config (file+prom export) |
| keycloak/realm-tellus.json | 7d908601970edd51c2276587468cdd28b4fd37a8373388196450ed2c6bf6fe11 | 110 | Keycloak realm import (verify users + tellus-app client) |
| scripts/quiver-verify.sh | 9a07981d5b4e1cc558aee3da15bae256e9201848e8f3499557073e8d642069ba | 380 | single-source-of-truth verification harness (12 stages) |
| scripts/verify-handoff.sh | d5730b3e21b291650060fd9f966f2bc6b2c9c3aa7668759fe08e1b703140f3aa | 76 | HANDOFF_INDEX integrity verifier |
| cypress.config.ts | b9d97d195b997d00ee348a51c3803495b15afa6b81c37b294bebbca1d22244aa | 46 | root cypress config (baseUrl env-driven, video on) |
| cypress/support/e2e.ts | 646b8e22cbf9d80a1a5337d22e9958daca12f50b4860e628e4257d54143cb50d | 69 | cypress global hooks + kcLogin command |
| cypress/e2e/quiver/gate-01-ot-convergence.cy.ts | e299c3b2c9e7747192838ceaae9020eaf63e539502af29bd1f2844b919ac2af6 | 120 | GATE-01 OT convergence E2E proof |
| cypress/e2e/quiver/gate-02-compute-cache-deadline.cy.ts | 2596968f71d392b01a674005bc64f85029cbe4fbebf16e3377d09302de297dd8 | 120 | GATE-02 cache hit + deadline boundary E2E |
| cypress/e2e/quiver/gate-04-auth-branch-propagation.cy.ts | 90c8656db3b3a39360b3e65c082c29be82706a1efc19b8ddfaaf7febabfe98ab | 86 | GATE-04 auth + branch propagation E2E |
| cypress/e2e/quiver/b9-aip-route.cy.ts | c1ffa8622f0be0eb75bf8fe431459270eb122b81782356256076e1685443c086 | 79 | B9 AIP generate + trace E2E |
| decisions/quiver/D-2026-05-05-cypress-test-auth.md | 6ded193c5a163ac932a90a90102da1d8cc7f5a5cb6dc4810e85f50fe5a3c1b51 | 75 | cypress test-auth bypass decision (CONTRACT §3) |
