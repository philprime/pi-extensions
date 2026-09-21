#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'Usage: %s [--reply THREAD_ID BODY_FILE ...] [--resolve THREAD_ID ...]\n' "$(basename "$0")" >&2
  exit 2
}

[[ $# -ge 2 ]] || usage

thread_ids=()
body_files=()
resolve_thread_ids=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reply)
      [[ $# -ge 3 ]] || usage

      thread_id=$2
      body_file=$3

      [[ -n "$thread_id" ]] || {
        printf 'THREAD_ID must not be empty\n' >&2
        exit 2
      }
      [[ -f "$body_file" && -r "$body_file" ]] || {
        printf 'BODY_FILE must be a readable file: %s\n' "$body_file" >&2
        exit 2
      }

      thread_ids+=("$thread_id")
      body_files+=("$body_file")
      shift 3
      ;;
    --resolve)
      [[ $# -ge 2 ]] || usage

      thread_id=$2
      [[ -n "$thread_id" ]] || {
        printf 'THREAD_ID must not be empty\n' >&2
        exit 2
      }

      resolve_thread_ids+=("$thread_id")
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ ${#thread_ids[@]} -gt 0 || ${#resolve_thread_ids[@]} -gt 0 ]] || usage

operations='[]'
pending_review_ids='[]'

if [[ ${#thread_ids[@]} -gt 0 ]]; then
  graphql_variables=""
  graphql_replies=""
  gh_args=(api graphql)

  for index in "${!thread_ids[@]}"; do
    if [[ -n "$graphql_variables" ]]; then
      graphql_variables+=", "
    fi
    graphql_variables+="\$threadId${index}: ID!, \$body${index}: String!"
    graphql_replies+="
      r${index}: addPullRequestReviewThreadReply(
        input: {
          pullRequestReviewThreadId: \$threadId${index}
          body: \$body${index}
        }
      ) {
        comment {
          id
          state
          pullRequestReview {
            id
            state
          }
        }
      }"
    gh_args+=(-F "threadId${index}=${thread_ids[$index]}")
    gh_args+=(-F "body${index}=@${body_files[$index]}")
  done

  graphql_query="mutation(${graphql_variables}) {${graphql_replies}
    }"
  reply_response=$(gh "${gh_args[@]}" -f "query=$graphql_query")

  for index in "${!thread_ids[@]}"; do
    comment_path=".data.r${index}.comment"
    comment_id=$(jq -er "${comment_path}.id" <<< "$reply_response")
    comment_state=$(jq -er "${comment_path}.state" <<< "$reply_response")
    review_id=$(jq -er "${comment_path}.pullRequestReview.id" <<< "$reply_response")
    review_state=$(jq -er "${comment_path}.pullRequestReview.state" <<< "$reply_response")

    operations=$(jq -c \
      --arg thread_id "${thread_ids[$index]}" \
      --arg comment_id "$comment_id" \
      --arg review_id "$review_id" \
      --arg review_state "$review_state" \
      '. + [{
        thread_id: $thread_id,
        comment_id: $comment_id,
        review_id: $review_id,
        review_state: $review_state,
        status: "ok"
      }]' <<< "$operations")

    if [[ "$comment_state" == "PENDING" || "$review_state" == "PENDING" ]]; then
      pending_review_ids=$(jq -c --arg review_id "$review_id" '
        if index($review_id) then . else . + [$review_id] end
      ' <<< "$pending_review_ids")
    fi
  done

  while IFS= read -r review_id; do
    # GraphQL variables must remain literal for gh to submit them.
    # shellcheck disable=SC2016
    submit_response=$(gh api graphql \
      -F reviewId="$review_id" \
      -f query='
        mutation($reviewId: ID!) {
          submitPullRequestReview(
            input: {
              pullRequestReviewId: $reviewId
              event: COMMENT
            }
          ) {
            pullRequestReview {
              id
              state
            }
          }
        }
      ')

    review_state=$(jq -er '.data.submitPullRequestReview.pullRequestReview.state' <<< "$submit_response")
    [[ "$review_state" != "PENDING" ]] || {
      printf 'Review remains pending after submission: %s\n' "$review_id" >&2
      exit 1
    }

    operations=$(jq -c --arg review_id "$review_id" --arg review_state "$review_state" '
      map(
        if .review_id == $review_id then
          .review_state = $review_state
        else
          .
        end
      )
    ' <<< "$operations")
  done < <(jq -r '.[]' <<< "$pending_review_ids")
fi

resolutions='[]'

if [[ ${#resolve_thread_ids[@]} -gt 0 ]]; then
  graphql_variables=""
  graphql_resolutions=""
  gh_args=(api graphql)

  for index in "${!resolve_thread_ids[@]}"; do
    if [[ -n "$graphql_variables" ]]; then
      graphql_variables+=", "
    fi
    graphql_variables+="\$resolveThreadId${index}: ID!"
    graphql_resolutions+="
      x${index}: resolveReviewThread(
        input: {threadId: \$resolveThreadId${index}}
      ) {
        thread {
          id
          isResolved
        }
      }"
    gh_args+=(-F "resolveThreadId${index}=${resolve_thread_ids[$index]}")
  done

  graphql_query="mutation(${graphql_variables}) {${graphql_resolutions}
    }"
  resolve_response=$(gh "${gh_args[@]}" -f "query=$graphql_query")

  for index in "${!resolve_thread_ids[@]}"; do
    thread_path=".data.x${index}.thread"
    resolved_thread_id=$(jq -er "${thread_path}.id" <<< "$resolve_response")
    is_resolved=$(jq -r "${thread_path}.isResolved" <<< "$resolve_response")

    [[ "$resolved_thread_id" == "${resolve_thread_ids[$index]}" && "$is_resolved" == "true" ]] || {
      printf 'Review thread was not resolved: %s\n' "${resolve_thread_ids[$index]}" >&2
      exit 1
    }

    resolutions=$(jq -c \
      --arg thread_id "$resolved_thread_id" \
      --argjson is_resolved "$is_resolved" \
      '. + [{
        thread_id: $thread_id,
        is_resolved: $is_resolved,
        status: "ok"
      }]' <<< "$resolutions")
  done
fi

jq -n \
  --argjson operations "$operations" \
  --argjson resolutions "$resolutions" \
  '{
    replied: ($operations | length),
    resolved: ($resolutions | length),
    operations: $operations,
    resolutions: $resolutions,
    status: "ok"
  }'
