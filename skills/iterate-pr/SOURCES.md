# Iterate PR Sources

## Iteration Changelog

### Resolve addressed review threads

- **Evidence:** Human-verified regression from PR iteration where the requested reply was published but the thread remained unresolved.
- **Negative example:** The wrapper reported a successful reply, and the agent implied completion even though no `resolveReviewThread` mutation existed.
- **Behavior delta:** The wrapper now accepts explicit `--resolve THREAD_ID` operations, supports resolve-only calls, batches confirmed resolutions after replies are published, and verifies `isResolved: true`.
- **Preserved behavior:** All GitHub writes remain fixed-purpose operations that require explicit confirmation, resolution requires a separate explicit user request, and reply bodies still come from files.

### Submit review-thread replies

- **Evidence:** GitHub can create a review-thread reply in a pending review, especially when multiple reply mutations race.
- **Negative example:** The reply wrapper returned success for a created comment ID while the reply remained unpublished in a pending review.
- **Behavior delta:** The wrapper restores the previous helper's single-request batching, reads each created comment's review state, submits pending reviews with a `COMMENT` event, and reports the final state.
- **Preserved behavior:** Replies still require explicit confirmation and use a fixed-purpose wrapper with body files.

### Narrow GitHub API wrappers

- **Evidence:** Local permission rules need to distinguish fixed read and reply operations from unrestricted `gh api` access.
- **Negative example:** Allow-listing the generic `gh api` command permits both reads and arbitrary writes, while Python helpers obscure otherwise standard `gh` operations.
- **Behavior delta:** Standard PR checks and run logs use direct `gh` commands. Each required GraphQL query or mutation lives in a narrow shell wrapper that can be allow-listed independently.
- **Preserved behavior:** Feedback remains categorized, checks and feedback are monitored in parallel, human gates terminate monitoring, and review-thread replies remain available after explicit confirmation.

### Feedback monitor completion

- **Evidence:** Human-verified regression from an `iterate-pr` run.
- **Negative example:** CI had no actionable pending checks and feedback was clear, but `monitor_pr_feedback.py` continued polling until its 30-minute timeout.
- **Behavior delta:** After a clear feedback fetch, the monitor now checks registered CI state and exits with `NO_ACTIONABLE_FEEDBACK` when no actionable checks remain.
- **Preserved behavior:** Actionable feedback still exits immediately, missing checks still receive their registration grace period through the parallel check monitor, and transient check-fetch failures do not cause early completion.
