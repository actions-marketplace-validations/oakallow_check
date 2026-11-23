#!/usr/bin/env bash
# Runs the action on this machine against the live oakallow MCP endpoint, the
# same way the GitHub runner would (INPUT_* env vars, output and summary
# files). The agent token is read from a hidden prompt so it never lands in
# shell history or on the command line.
#
# Usage: scripts/live-test.sh <tool> [wait-for-approval] [max-wait-minutes]

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: scripts/live-test.sh <tool> [wait-for-approval] [max-wait-minutes]" >&2
  exit 2
fi

TOOL="$1"
WAIT="${2:-true}"
MAX_WAIT="${3:-10}"

if [ -z "${OAKALLOW_AGENT_TOKEN:-}" ]; then
  read -r -s -p "oakallow agent token: " OAKALLOW_AGENT_TOKEN
  echo
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
touch "$WORK/output" "$WORK/summary"

set +e
env GITHUB_OUTPUT="$WORK/output" GITHUB_STEP_SUMMARY="$WORK/summary" \
    GITHUB_REPOSITORY="oakallow/check-live-test" GITHUB_RUN_ID="$(date +%s)" GITHUB_RUN_ATTEMPT="1" \
    GITHUB_WORKFLOW="live test" GITHUB_ACTOR="local" GITHUB_SHA="0000000" GITHUB_REF_NAME="main" \
    "INPUT_AGENT-TOKEN=$OAKALLOW_AGENT_TOKEN" "INPUT_TOOL=$TOOL" \
    "INPUT_WAIT-FOR-APPROVAL=$WAIT" "INPUT_MAX-WAIT-MINUTES=$MAX_WAIT" "INPUT_POLL-SECONDS=10" \
    node "$ROOT/src/main.js"
CODE=$?
set -e

echo
echo "---- outputs ----"
awk '/<<ghadelimiter_/{split($0,a,"<<"); name=a[1]; getline; print name ": " $0}' "$WORK/output"
echo "---- summary ----"
cat "$WORK/summary"
echo "---- exit code: $CODE ----"
exit $CODE
