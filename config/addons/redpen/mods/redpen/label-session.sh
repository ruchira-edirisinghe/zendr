#!/bin/sh
# Claude Code SessionStart hook: labels the Herdr terminal with this Claude's transcript path.
# The redpen mod reads the label claude.transcript to find the latest reply.
# Does nothing outside Herdr (no HC_TERMINAL_ID) or for subagents.
# Never blocks Claude Code from starting (always exits 0).
[ -n "${HC_TERMINAL_ID:-}" ] || exit 0
command -v hc >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
[ -z "$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)" ] || exit 0

transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
[ -n "$transcript" ] || exit 0

hc label "$HC_TERMINAL_ID" "claude.transcript=$transcript" >/dev/null 2>&1 || true
exit 0
