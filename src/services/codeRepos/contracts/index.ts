// ---------------------------------------------------------------------------
// Code Repositories — Global contracts barrel
//
// Re-exports the building blocks every service in the surface uses:
//   - regex.ts     : G-C-27..32  field validators
//   - rid.ts       : G-C-01..06  RID parser/minter
//   - errors.ts    : G-C-12..16  envelope + error names
//   - etag.ts      : G-C-17..19  weak ETag helpers
//   - idempotency.ts: G-C-20..23 idempotency key + replay decision
// ---------------------------------------------------------------------------

export * from "./regex";
export * from "./rid";
export * from "./errors";
export * from "./etag";
export * from "./idempotency";
