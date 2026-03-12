# TASK 9: Build the ONE_TO_ONE Link Resolver

**Objective:** Implement the link resolution logic for ONE_TO_ONE cardinality links. A ONE_TO_ONE link connects exactly one source object to exactly one target object. The foreign key can be on either side. For example, a User has one Profile (User.profileId → Profile), or a Profile belongs to one User (Profile.userId → User).

**Implementation:** This is essentially the same as MANY_TO_ONE (when FK is on the source side) or a single-result version of ONE_TO_MANY (when FK is on the target side). Create a function `resolveOneToOne` in `src/services/linkResolver.js`:

```javascript
async function resolveOneToOne({ sourcePrimaryKey, linkType }) {
    if (linkType.foreign_key_side === 'source') {
        // FK is on source: source has a property pointing to target's PK
        // This is identical to MANY_TO_ONE resolution
        return resolveManyToOne({ sourcePrimaryKey, linkType });
    } else {
        // FK is on target: target has a property pointing to source's PK
        // This is a restricted version of ONE_TO_MANY (expect exactly 0 or 1 result)
        const result = await resolveOneToMany({
            sourcePrimaryKey,
            linkType,
            pageSize: 2, // fetch 2 to detect violations
        });
        
        if (result.data.length === 0) {
            return { data: null, linked: false, reason: 'No target object found.' };
        }
        
        if (result.data.length > 1) {
            // ONE_TO_ONE violation: multiple targets found
            // Palantir behavior: return the first one but log a warning
            console.warn(`[ONE_TO_ONE_VIOLATION] Link ${linkType.api_name}: source PK '${sourcePrimaryKey}' has ${result.totalCount} linked targets. Expected at most 1.`);
        }
        
        return { data: result.data[0], linked: true };
    }
}
```

**Key behavior:** ONE_TO_ONE does not strictly enforce uniqueness at the database level — it's a schema-level declaration. If the data violates the ONE_TO_ONE constraint (multiple targets for the same source), the resolver returns the first result and logs a warning. Palantir handles this the same way — the Ontology Manager shows a data quality warning but doesn't prevent queries.

**Dependencies:**
- Import `resolveOneToMany` and `resolveManyToOne` from the same file (Tasks 7 and 8).

**File to modify:** `src/services/linkResolver.js` — add `resolveOneToOne` alongside the other resolvers.

**Testing:**
1. Create User USR-001 with profileId="PRF-001". Create Profile PRF-001. Create ONE_TO_ONE link (User → Profile, FK: profileId on source, bidirectional).
2. Call `resolveOneToOne({ sourcePrimaryKey: 'USR-001', linkType })` — verify `{ data: { __primaryKey: 'PRF-001', ... }, linked: true }`.
3. Create User USR-002 with profileId=null. Resolve — verify `{ data: null, linked: false, reason: 'Foreign key property value is null.' }`.
4. Create a ONE_TO_ONE link with FK on target side. Create two target objects pointing to the same source PK (violation). Resolve — verify one result is returned AND `console.warn` is called with `[ONE_TO_ONE_VIOLATION]`.
5. Test with no matching target object — verify `{ data: null, linked: false, reason: 'No target object found.' }`.
