#!/usr/bin/env bash
# Isolated codex run for hub issue #18, instance 1 (codex-run-1). 45-minute wall clock via perl alarm.
set -uo pipefail
RUN="$(cd "$(dirname "$0")" && pwd)"
WORK="$RUN/../../executor-s0"
PROMPT="$(cat "$RUN/PROMPT.md")"
cd "$WORK"
CODEX_HOME=/Users/b.c.nims/dev/employment-ops-home/mechanize/invariant-task/.codex-home \
  perl -e 'alarm 2700; exec @ARGV' -- codex exec --skip-git-repo-check --sandbox workspace-write --json \
  -o "$RUN/last-message.md" "$PROMPT" \
  < /dev/null > "$RUN/transcript.jsonl" 2> "$RUN/stderr.log"
echo "exit=$?"
