#!/usr/bin/env bash
set -euo pipefail

# TXE count-floor gate (plan aztec-5-stable, audit F-16/I4): "exit 0" alone lets a
# silently-skipped suite pass — a 90% drop in executed tests is invisible to the exit
# code. Parses the PTY transcript of `aztec test` and enforces a minimum total.
#
# Counting uses awk matching (NOT grep): under `set -euo pipefail`, a counting grep that
# legitimately matches nothing (e.g. zero "tests failed" lines on a clean run) exits 1 and
# kills the script before it prints anything — exactly how this gate's first CI run died.
#
# Usage: check-txe-counts.sh <transcript-file> <min-total>

FILE="$1"; MIN="$2"

[ -r "$FILE" ] || { echo "ERROR: transcript $FILE missing/unreadable" >&2; exit 1; }

read -r TOTAL FAILED < <(
  sed 's/\x1b\[[0-9;]*m//g' "$FILE" | awk '
    {
      if (match($0, /[0-9]+ tests? passed/)) { s = substr($0, RSTART, RLENGTH); split(s, a, " "); passed += a[1] }
      if (match($0, /[0-9]+ tests? failed/)) { s = substr($0, RSTART, RLENGTH); split(s, a, " "); failed += a[1] }
    }
    END { print passed + 0, failed + 0 }
  '
)

echo "check-txe-counts: $TOTAL passed, $FAILED failed (floor: $MIN)"
if [ "$FAILED" -gt 0 ]; then
  echo "ERROR: $FAILED test(s) failed" >&2
  exit 1
fi
if [ "$TOTAL" -lt "$MIN" ]; then
  echo "ERROR: only $TOTAL tests ran — floor is $MIN (silently-skipped suites?)" >&2
  exit 1
fi
