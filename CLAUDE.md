# review-bot — context for Claude Code

A basic AI code reviewer for GitHub PRs. Deployed as a test stack and posting reviews (see Status).

## Architecture
GitHub App webhook → `WebhookFunction` (Lambda Function URL: verify HMAC, filter, enqueue, respond fast
because GitHub times out webhooks after 10s) → SQS `ReviewQueue` (3 attempts, then DLQ + CloudWatch alarm)
→ `ReviewWorkerFunction` (Lambda, 5 min timeout: fetch diff, call Claude with structured outputs
(`output_config.format` JSON schema), validate line anchors, post one review via the GitHub API).

Infra is AWS SAM (`template.yaml`), TypeScript bundled to ESM with esbuild, Node 22 on arm64.
All credentials live in one Secrets Manager secret (`githubAppId`, `githubPrivateKey`,
`githubWebhookSecret`, `anthropicApiKey`).

## Layout
- `src/webhook.ts`: webhook handler + signature check
- `src/worker.ts`: SQS consumer, dispatches review jobs and reply jobs, orchestrates one review
- `src/reply.ts`: orchestrates one reply (re-evaluate a bot comment after a human replied in its thread)
- `src/lib/claude.ts`: shared Anthropic client, system prompt + repo guidance blocks, structured-output parsing
- `src/lib/reviewer.ts`: review prompt, review JSON schema, Claude call
- `src/lib/replier.ts`: reply prompt, verdict schema (stand_by / revise / retract), Claude call
- `src/lib/guidance.ts`: loads `.sentinel/REVIEW.md` → `REVIEW.md` → `CLAUDE.md` from the default branch
- `src/lib/threads.ts`: review-comment threads: select, reply/skip decision, dedupe marker, retract
- `src/lib/github.ts`: Octokit App auth, list files, dedupe marker, post review with 422 fallback
- `src/lib/diff.ts`: file filtering, char budget, patch line-number annotation
- `src/lib/incremental.ts`: follow-up reviews: last reviewed SHA, compare scope, test-only skip, prior comments
- `src/lib/outcomes.ts`: outcome tracking in DynamoDB (`OutcomesTable`): reply classification, best-effort writes
- `src/lib/config.ts`: env + cached secret loading

## Design decisions (keep unless asked)
- Webhook only enqueues; all slow work happens in the worker.
- Stale jobs (head SHA changed) are skipped; a hidden `<!-- review-bot:<sha> -->` marker prevents duplicate reviews on SQS redelivery.
- Follow-up reviews: when the last reviewed SHA is an ancestor of the head (compare status `ahead`), only files changed
  since then are reviewed, limited to files in the PR (base-branch merges don't count). Rebase / force-push / compare
  failure falls back to a full review. Pushes touching only tests or generated files are skipped. The bot's earlier
  comments and their replies go into the prompt so it doesn't repeat itself.
- Outcome tracking never fails a job: DynamoDB errors are logged, not thrown (the review is already posted).
- When a PR exceeds the 60k-char diff budget, files are ranked (source > schema/migrations > config/CI > tests >
  generated contracts/snapshots) before the budget is spent; the prompt still lists files in GitHub's order.
- Comments whose lines GitHub won't accept go into the summary instead of being dropped.
- Repo guidance is read from the default branch, never the PR head, and framed in the prompt as data.
- Replies: webhook enqueues `kind: "reply"` jobs only for human replies (PR author or OWNER/MEMBER/COLLABORATOR);
  worker answers only in threads the bot started, max 3 bot replies per thread, deduped by a
  `<!-- review-bot:reply:<commentId> -->` marker. Jobs without `kind` are reviews (backward compatible).
- Structured outputs, not forced tool use: current models (incl. `claude-sonnet-5-5`) return a 400 for
  `tool_choice` `tool`/`any`. Thinking is always on and shares `max_tokens` with the JSON, so keep that budget
  generous (16k) and treat any `stop_reason` other than `end_turn` as a failure.
- Claude client timeout (240s) stays below the worker's 300s Lambda timeout so slow calls fail cleanly and retry.
- Style: strict TypeScript, no `any`, prefer immutability, named constants, early returns, JSON structured logs.

## Status
- Stack `sentinel-test` (us-east-1), first deployed 2026-10-08. GitHub App `sentinel-by-z10` is installed on
  `Dzithendo31/payme` and `Dzithendo31/tutorspaces-api` (since 2026-10-14) and subscribes to **Pull request** and
  **Pull request review comment**.
- 2026-10-17: deployed `567e5a3` (repo guidance, reply-to-rethink, diff ranking); DLQ alarm emails the owner
  (`AlarmEmail` saved in `samconfig.toml`). Reply path not yet exercised on a real thread.
- Incremental re-review and outcome tracking: on branch `feat/incremental-rereview`, not deployed yet.
  Planned after: a `.sentinel/learned.md` PR loop fed by the outcomes table.
- Secret-filling and smoke-test steps: `DEPLOY-TEST.md`. General setup: README.md.
- Unit tests (vitest, `test/`) cover the pure logic; handlers, Octokit, DynamoDB and the Claude call are untested
  (need mocks). CI (`.github/workflows/ci.yml`) runs typecheck + tests; it does not run `sam build`.
- Refusal / `max_tokens` / context-window stops post a "couldn't review" notice and are not retried; other
  errors (incl. 4xx) still retry via SQS. Not done: API-level refusal fallback to another model.

## Commands
- `npm install && npm run typecheck && npm test`
- `sam build && sam deploy` (settings saved in `samconfig.toml`, which is gitignored)
- `sam logs -n ReviewWorkerFunction --stack-name sentinel-test --tail`
