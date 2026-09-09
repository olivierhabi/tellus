// TEMPORARY CI lint-gate probe — intentional security/detect-eval-with-expression
// violation to prove the Lint & SAST job fails the workflow. Reverted immediately.
const expr = "1+1";
export const lintGateProbe = eval(expr);
