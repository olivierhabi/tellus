# Datasource Attachment Funnel Trigger Fix

## Problem Statement

When attaching a datasource to an object type via the endpoint:
```
POST /api/v1/ontology/object-types/:objectTypeRid/datasources
```

The system was not triggering the indexing funnel pipeline, leaving the object type's data unindexed.

## Root Cause

The `datasource-compiler-consumer.ts` successfully compiled and updated the runtime layer's `backing_datasource` table but did not signal the funnel workflow to start indexing. Other schema-changing operations (property creation, object type updates) all call `sendSignal()` to trigger the funnel, but datasource attachment was missing this trigger.

## Solution

Added funnel signal emission after datasource attachment compilation in `src/services/orchestration/datasource-compiler-consumer.ts`:

### Key Changes

1. **Import sendSignal**: Added import for the funnel's signal mechanism
2. **Enhanced Query**: Modified the object type lookup to also fetch `ontology_id` needed for the signal
3. **Signal Emission**: Added `sendSignal()` call after successful datasource compilation
4. **Idempotency**: Used fingerprint-based deduplication to prevent duplicate signals
5. **Error Handling**: Non-fatal error handling - if signal fails, attachment still succeeds

### Implementation Details

```typescript
// After successful datasource compilation:
const signalId = await sendSignal({
  ontologyId,
  objectTypeApiName: apiName,
  signalType: "schemaChanged",
  payload: {
    reason: "datasource_attached",
    datasourceRid: payload.datasourceRid,
    objectTypeRid: payload.objectTypeRid,
  },
  fingerprint: `ds-attach-${payload.objectTypeRid}-${payload.datasourceRid}`,
});
```

### Design Principles

1. **Production-Ready**: Non-blocking - signal failure doesn't fail the attachment
2. **Scalable**: Uses existing event-driven architecture
3. **Observable**: Comprehensive logging at every step
4. **Idempotent**: Fingerprint ensures duplicate attachments don't create duplicate signals
5. **Consistent**: Follows the same pattern as other schema-changing operations

## Testing

### Automated Tests

Run the comprehensive test suite:

```bash
# Set environment variables
export BASE_URL="http://localhost:3000"
export API_KEY="your-api-key"

# Run simple test
./test-datasource-attach.sh <object_type_rid> <datasource_rid>

# Run comprehensive test suite
./test-datasource-funnel-trigger.sh
```

### Manual Verification

1. **Attach a datasource**:
   ```bash
   curl -X POST http://localhost:3000/api/v1/ontology/object-types/<rid>/datasources \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{
       "datasourceRid": "ri.stemma.main.dataset.test",
       "primaryKeyMapping": "id",
       "propertyMappings": [{"sourceColumn": "id", "targetPropertyId": "id"}]
     }'
   ```

2. **Check server logs** for:
   ```
   [info] Legacy runtime layer synced and logical view compiled.
   [info] Funnel indexing signal sent after datasource attachment.
   ```

3. **Verify funnel state**:
   ```bash
   curl http://localhost:3000/api/v1/ontology/<ontologyId>/objectTypes/<apiName>/indexing/status
   ```

4. **Check database** (optional):
   ```sql
   SELECT * FROM funnel_signal
   WHERE object_type_api_name = '<apiName>'
   AND signal_type = 'schemaChanged'
   ORDER BY received_at DESC LIMIT 1;
   ```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ POST /api/v1/ontology/object-types/:rid/datasources        │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ objectTypeService.addDatasource()                           │
│  - Update object_type_datasources (Blueprint Layer)          │
│  - Emit DataSourceAddedEvent                                │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼ (event bus)
┌─────────────────────────────────────────────────────────────┐
│ datasource-compiler-consumer                                │
│  - Compile logical union view                                │
│  - Update backing_datasource (Runtime Layer)                │
│  - ✨ sendSignal(schemaChanged)  <-- NEW                    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Funnel Workflow (changelog → merge → indexing → hydration) │
└─────────────────────────────────────────────────────────────┘
```

## Monitoring

### Key Metrics to Monitor

1. **Signal creation rate**: Count of `schemaChanged` signals with `datasource_attached` reason
2. **Signal processing latency**: Time from signal creation to funnel start
3. **Indexing success rate**: Percentage of datasource attachments that result in successful indexing

### Logging

The implementation provides structured JSON logging at multiple levels:

- `info`: View compilation triggered, successful completion, signal sent
- `warn`: Signal send failure (non-fatal)
- `error`: Compilation failure, mapping errors

### Alerting Recommendations

Alert on:
- High rate of signal send failures
- Datasource attachments not resulting in funnel state changes
- Compilation errors in datasource-compiler-consumer

## Rollback

If issues arise, the change can be safely reverted:

1. The signal emission is non-blocking
2. Attachment functionality continues to work without it
3. Manual funnel trigger via `/reindex` endpoint works as fallback

## Future Improvements

1. **Batch Operations**: Signal batching for bulk datasource attachments
2. **Priority Signals**: Higher priority for datasource attachment signals
3. **Retry Mechanism**: Automatic retry for failed signal sends
4. **Metrics Integration**: Prometheus metrics for signal success rates
5. **UI Indicator**: Show "indexing pending" badge after attachment

## Related

- Issue: https://github.com/olivierhabi/tellus/issues/XX
- PR: https://github.com/olivierhabi/tellus/pull/XX
- Documentation: `docs/funnel-pipeline.md`
- Tests: `test-datasource-funnel-trigger.sh`
