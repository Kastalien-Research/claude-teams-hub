#!/usr/bin/env bash
# Isolated frontier-agent run for hub issue #18, instance 1 (claude-run-1).
# Run from anywhere; cds into executor-s0. 45-minute wall clock via perl alarm.
set -uo pipefail
RUN="$(cd "$(dirname "$0")" && pwd)"
WORK="$RUN/../../executor-s0"
PROMPT="$(cat "$RUN/PROMPT.md")"
cd "$WORK"
perl -e 'alarm 2700; exec @ARGV' -- claude -p "$PROMPT" --model claude-fable-5-1 \
  --output-format stream-json --verbose \
  --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --disallowedTools "WebFetch,WebSearch" --dangerously-skip-permissions \
  < /dev/null > "$RUN/transcript.jsonl" 2> "$RUN/stderr.log"
echo "exit=$?"
