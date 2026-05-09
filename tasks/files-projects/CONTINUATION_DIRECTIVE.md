# Files & Projects — Continuation Directive

This document is the loop-protocol companion to
`tasks/files-projects/files-projects-tasks-v2.md`. The agent reads §3 below at
turn-start and pastes its output verbatim before proceeding to that turn's
Actions.

## §1 — Where the truth lives

- Plan: `tasks/files-projects/files-projects-tasks-v2.md` (158 turns).
- Status: `tasks/files-projects/SUBTASKS.md`.
- Per-task progress notes: `tasks/files-projects/progress/<TASK>.md`.
- Verify scripts: `scripts/verify-<task>.sh` and `scripts/verify-all.sh`.

## §2 — Loop invariant

A turn is GREEN iff its Exit Gate, run as a literal bash command, exits 0.
Prose claims do not count. `SUBTASKS.md` mutates only on flip
(`⏳ → IN_PROGRESS → ✅`). Skipping `IN_PROGRESS` is a directive failure.

## §3 — Tail command (run at turn-start, paste output verbatim)

```bash
{
  echo "=== SUBTASKS.md tail ==="
  tail -n 30 tasks/files-projects/SUBTASKS.md
  echo
  echo "=== current IN_PROGRESS / first ⏳ ==="
  awk '/IN_PROGRESS|⏳/{print; n++; if(n>=3) exit}' tasks/files-projects/SUBTASKS.md
  echo
  echo "=== docker compose ps --format json (truncated) ==="
  docker ps --format '{{.Names}}\t{{.Status}}'
  echo
  echo "=== session start ==="
  ls -la /tmp/SESSION_START 2>/dev/null || echo "no session marker"
  echo
  echo "=== last 5 verify logs ==="
  ls -t /tmp/b*-*.log /tmp/f*-*.log 2>/dev/null | head -5
}
```

## §4 — Halt criteria

The agent halts only when:

1. The current turn's Exit Gate exits 0 (the normal end-of-turn halt) — then
   it flips status, prints `## TURN <id> EXIT_GREEN`, and ends stream.
2. Three documented retries of the same Action all fail
   (`STRUCTURAL_BLOCK` — paste failing command + stderr + 3 attempts).

There is no third halt condition. "Long output", "many tool calls", "next
session would be cleaner" are not stop reasons.
