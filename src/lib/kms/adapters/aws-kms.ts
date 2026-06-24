// AWS KMS adapter. See ./stubs.ts for the in-session behavior.
// Production replacement: implement `wrap`/`unwrap` via @aws-sdk/client-kms
// (already a transitive dep). The contract is KmsAdapter from ../index.ts.
export { AwsKmsAdapter } from "./stubs";
