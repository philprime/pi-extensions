#!/usr/bin/env bash

set -euo pipefail

pr_number=""

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
    --help)
      printf 'Usage: %s [--pr NUMBER]\n' "$(basename "$0")"
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$pr_number" ]]; then
  pr_number=$(gh pr view --json number --jq '.number')
fi

# GraphQL variables must remain literal for gh to submit them.
# shellcheck disable=SC2016
gh api graphql \
  -F owner='{owner}' \
  -F repo='{repo}' \
  -F pr="$pr_number" \
  -f query='
    query($owner: String!, $repo: String!, $pr: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $pr) {
          number
          url
          reviewDecision
          isDraft
          author { login }
          reviews(first: 100) {
            nodes {
              state
              body
              author { login }
            }
          }
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              comments(first: 100) {
                nodes {
                  id
                  body
                  url
                  author { login }
                }
              }
            }
          }
          comments(first: 100) {
            nodes {
              body
              url
              author { login }
            }
          }
        }
      }
    }
  ' | jq '
    def author_login: .author.login // "";
    def review_bot:
      author_login | test("^(warden|cursor|bugbot|seer|copilot|codex|claude|codeql)"; "i");
    def info_bot:
      author_login
      | test("^(codecov|dependabot|renovate|github-actions|mergify|semantic-release|sonarcloud|snyk)|bot$|\\[bot\\]$"; "i");
    def priority:
      (.body // "") as $body
      | if (info_bot and (review_bot | not)) then
          "bot"
        elif ($body | test("^\\s*(h:|h\\s*:|high:|\\[h\\])|must\\s+(fix|change|update|address)|this\\s+(is\\s+)?(wrong|incorrect|broken|buggy)|security\\s+(issue|vulnerability|concern)|will\\s+(break|cause|fail)|critical|blocker"; "i")) then
          "high"
        elif ($body | test("^\\s*(l:|l\\s*:|low:|\\[l\\])|nit[:\\s]|nitpick|suggestion[:\\s]|consider\\s+|could\\s+(also\\s+)?|might\\s+(want\\s+to|be\\s+better)|optional[:\\s]|minor[:\\s]|style[:\\s]|prefer\\s+|what\\s+do\\s+you\\s+think|up\\s+to\\s+you|take\\s+it\\s+or\\s+leave|fwiw"; "i")) then
          "low"
        else
          "medium"
        end;
    def feedback_item($pr_author):
      (author_login) as $author
      | (.body // "") as $body
      | {
          author: $author,
          body: ($body | gsub("\\n"; " ") | if length > 200 then .[0:200] + "..." else . end),
          full_body: $body
        }
        + if $author == $pr_author then {self_authored: true} else {} end;
    def bucket($items; $name):
      [$items[] | select(.category == $name) | .item];

    .data.repository.pullRequest as $pr
    | if $pr == null then error("Pull request not found") else $pr end
    | ($pr.author.login // "") as $pr_author
    | [
        ($pr.reviews.nodes[]?
          | select(.state == "CHANGES_REQUESTED")
          | select((.body // "") != "")
          | select(author_login != $pr_author)
          | {
              category: "high",
              item: (feedback_item($pr_author) + {type: "changes_requested"})
            }),
        ($pr.reviewThreads.nodes[]? as $thread
          | $thread.comments.nodes[0]? as $comment
          | select(($comment.body // "") | length >= 3)
          | {
              category: (if $thread.isResolved then "resolved" else ($comment | priority) end),
              item: (
                ($comment | feedback_item($pr_author))
                + {thread_id: $thread.id}
                + if $thread.path then {path: $thread.path} else {} end
                + if $thread.line then {line: $thread.line} else {} end
                + if $comment.url then {url: $comment.url} else {} end
                + if $thread.isResolved then {resolved: true} else {} end
                + if $thread.isOutdated then {outdated: true} else {} end
                + if ($comment | review_bot) then {review_bot: true} else {} end
              )
            }),
        ($pr.comments.nodes[]?
          | select((.body // "") | length >= 3)
          | {
              category: priority,
              item: (
                feedback_item($pr_author)
                + if .url then {url: .url} else {} end
                + if review_bot then {review_bot: true} else {} end
              )
            })
      ] as $items
    | (bucket($items; "high")) as $high
    | (bucket($items; "medium")) as $medium
    | (bucket($items; "low")) as $low
    | (bucket($items; "bot")) as $bot
    | (bucket($items; "resolved")) as $resolved
    | {
        pr: {
          number: $pr.number,
          url: $pr.url,
          author: $pr_author,
          review_decision: ($pr.reviewDecision // "")
        },
        summary: {
          high: ($high | length),
          medium: ($medium | length),
          low: ($low | length),
          bot_comments: ($bot | length),
          resolved: ($resolved | length),
          review_bot_feedback: ([$high[], $medium[], $low[]] | map(select(.review_bot == true)) | length),
          needs_attention: (($high | length) + ($medium | length))
        },
        feedback: {
          high: $high,
          medium: $medium,
          low: $low,
          bot: $bot,
          resolved: $resolved
        },
        action_required: (
          if ($high | length) > 0 then "Address high-priority feedback before merge"
          elif ($medium | length) > 0 then "Address medium-priority feedback"
          elif ($low | length) > 0 then "Review low-priority suggestions - ask user which to address"
          else null
          end
        )
      }
  '
