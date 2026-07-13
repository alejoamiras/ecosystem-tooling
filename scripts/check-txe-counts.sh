#!/usr/bin/env bash
set -euo pipefail

# TXE count-floor gate (plan aztec-5-stable, audit F-16/I4): "exit 0" alone lets a
# silently-skipped suite pass — a 90% drop in executed tests is invisible to the exit
# code. Parses `aztec test` transcript output and enforces a minimum total.
#
# Usage: check-txe-counts.sh <transcript-file> <min-total>

FILE="$1"; MIN="$2"
TOTAL="$(sed 's/\x1b\[[0-9;]*m//g' "$FILE" | grep -oE '[0-9]+ tests? passed' | awk '{s+=$1} END {print s+0}')"
FAILED="$(sed 's/\x1b\[[0-9;]*m//g' "$FILE" | grep -oE '[0-9]+ tests? failed' | awk '{s+=$1} END {print s+0}')"

echo "check-txe-counts: $TOTAL passed, $FAILED failed (floor: $MIN)"
if [ "$FAILED" -gt 0 ]; then
  echo "ERROR: $FAILED test(s) failed" >&2
  exit 1
fi
if [ "$TOTAL" -lt "$MIN" ]; then
  echo "ERROR: only $TOTAL tests ran — floor is $MIN (silently-skipped suites?)" >&2
  exit 1
fi
