#!/usr/bin/env bash

set -euo pipefail

scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pr_number=""
poll_seconds=30
timeout_seconds=1800

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pr)
      [[ $# -ge 2 ]] || {
        printf 'Missing value for --pr\n' >&2
        exit 2
      }
      pr_number=$2
      shift 2
      ;;
    --poll-seconds)
      [[ $# -ge 2 ]] || {
        printf 'Missing value for --poll-seconds\n' >&2
        exit 2
      }
      poll_seconds=$2
      shift 2
      ;;
    --timeout-seconds)
      [[ $# -ge 2 ]] || {
        printf 'Missing value for --timeout-seconds\n' >&2
        exit 2
      }
      timeout_seconds=$2
      shift 2
      ;;
    --help)
      printf 'Usage: %s [--pr NUMBER] [--poll-seconds SECONDS] [--timeout-seconds SECONDS]\n' "$(basename "$0")"
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

[[ "$poll_seconds" =~ ^[0-9]+$ ]] || {
  printf '--poll-seconds must be a non-negative integer\n' >&2
  exit 2
}
[[ "$timeout_seconds" =~ ^[0-9]+$ ]] || {
  printf '--timeout-seconds must be a non-negative integer\n' >&2
  exit 2
}

if [[ -z "$pr_number" ]]; then
  pr_number=$(gh pr view --json number --jq '.number')
fi

started_at=$SECONDS
human_gate_pattern='review[[:space:]]+required|required[[:space:]]+review|requires[[:space:]]+review|required[[:space:]]+approving[[:space:]]+review|approval[[:space:]]+required|waiting[[:space:]]+for[[:space:]]+approval|manual[[:space:]]+approval|draft[[:space:]]+(pull[[:space:]]+request|pr)'

while true; do
  feedback=""
  if feedback=$("$scripts_dir/fetch-pr-feedback.sh" --pr "$pr_number"); then
    high=$(jq -r '.summary.high // 0' <<< "$feedback")
    medium=$(jq -r '.summary.medium // 0' <<< "$feedback")
    low=$(jq -r '.summary.low // 0' <<< "$feedback")

    if ((high > 0 || medium > 0)); then
      printf 'FEEDBACK_NEEDS_ATTENTION\n%s\n' "$feedback"
      exit 0
    fi
    if ((low > 0)); then
      printf 'LOW_PRIORITY_FEEDBACK\n%s\n' "$feedback"
      exit 0
    fi

    checks=""
    checks_status=0
    checks=$(gh pr checks "$pr_number" --json name,bucket,state,description,workflow,link 2>/dev/null) || checks_status=$?
    if [[ -n "$checks" ]] && jq -e 'type == "array"' <<< "$checks" >/dev/null; then
      total=$(jq 'length' <<< "$checks")
      actionable_pending=$(jq --arg pattern "$human_gate_pattern" '
        [
          .[]
          | select(.bucket == "pending")
          | ([.name, .state, .description, .workflow] | map(. // "") | join(" ")) as $description
          | select(($description | test($pattern; "i")) | not)
        ]
        | length
      ' <<< "$checks")

      if ((total > 0 && actionable_pending == 0)); then
        printf 'NO_ACTIONABLE_FEEDBACK\n%s\n' "$feedback"
        exit 0
      fi
    elif ((checks_status != 0 && checks_status != 1 && checks_status != 8 && checks_status != 16)); then
      :
    fi
  fi

  if ((SECONDS - started_at >= timeout_seconds)); then
    if [[ -n "$feedback" ]]; then
      printf 'NO_ACTIONABLE_FEEDBACK\n%s\n' "$feedback"
      exit 0
    fi
    printf 'FEEDBACK_MONITOR_ERROR\n' >&2
    exit 1
  fi

  sleep "$poll_seconds"
done
