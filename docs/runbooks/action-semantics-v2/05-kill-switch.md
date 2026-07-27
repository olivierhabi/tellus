# Kill-Switch Runbook

`ACTION_SEMANTICS_V2_KILL_SWITCH=true` forces both v2 execution and v2 creation off, regardless of the other flags. v1 is unaffected.

## Activate
```
ACTION_SEMANTICS_V2_KILL_SWITCH=true   # then restart the app
```
- v2 action-type executions now return 422 `UNSUPPORTED_SEMANTICS_VERSION` (Stage 1b fail-closed).
- v2 action-type creation returns 422 (creation flag forced off).
- v1 executions and v1 creations are unchanged.

## Verify
- Attempt a v2 execute → 422 with `enforcementDisabled: true`.
- Attempt v1 execute → succeeds.
- Audit rows for v2 attempts record `result=failed` with `failure_type=unclassified`; v1 attempts unaffected.

## Deactivate
- Set `ACTION_SEMANTICS_V2_KILL_SWITCH=false` (or unset) and ensure `ACTION_SEMANTICS_V2_ENABLED`/`PROJECTION_READY`/`CREATION` are still as intended, then restart.
- Do NOT flip the kill switch as a routine rollout control — it is for incidents. Routine rollout uses the individual flags.
