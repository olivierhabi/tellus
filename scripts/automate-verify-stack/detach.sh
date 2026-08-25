#!/usr/bin/env bash
# Portable setsid(1) for macOS (no setsid binary) + Linux.
# Detaches the command into its own session/process group so a killed or
# timed-out invoking shell cannot take the daemon down with it.
#   detach.sh <logfile> <pidfile> <command...>
set -uo pipefail
LOG="$1"; PIDFILE="$2"; shift 2
python3 - "$LOG" "$PIDFILE" "$@" <<'PY'
import os, sys

log, pidfile, cmd = sys.argv[1], sys.argv[2], sys.argv[3:]
pid = os.fork()
if pid > 0:
    with open(pidfile, "w") as fh:
        fh.write(str(pid))
    os._exit(0)
os.setsid()
fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
os.dup2(fd, 1)
os.dup2(fd, 2)
devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0)
os.execvp(cmd[0], cmd)
PY
