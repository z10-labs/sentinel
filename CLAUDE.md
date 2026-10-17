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
- `src/worker.ts`: SQS consumer, orchestrates one review
- `src/lib/reviewer.ts`: prompt, review JSON schema, Claude call
- `src/lib/github.ts`: Octokit App auth, list files, dedupe marker, post review with 422 fallback
- `src/lib/diff.ts`: file filtering, char budget, patch line-number annotation
- `src/lib/config.ts`: env + cached secret loading

## Design decisions (keep unless asked)
- Webhook only enqueues; all slow work happens in the worker.
- Stale jobs (head SHA changed) are skipped; a hidden `<!-- review-bot:<sha> -->` marker prevents duplicate reviews on SQS redelivery.
- When a PR exceeds the 60k-char diff budget, files are ranked (source > schema/migrations > config/CI > tests >
  generated contracts/snapshots) before the budget is spent; the prompt still lists files in GitHub's order.
- Comments whose lines GitHub won't accept go into the summary instead of being dropped.
- Structured outputs, not forced tool use: current models (incl. `claude-sonnet-5-5`) return a 400 for
  `tool_choice` `tool`/`any`. Thinking is always on and shares `max_tokens` with the JSON, so keep that budget
  generous (16k) and treat any `stop_reason` other than `end_turn` as a failure.
- Claude client timeout (240s) stays below the worker's 300s Lambda timeout so slow calls fail cleanly and retry.
- Style: strict TypeScript, no `any`, prefer immutability, named constants, early returns, JSON structured logs.

## Status
- Deployed 2026-10-08 as stack `sentinel-test` (us-east-1). GitHub App `sentinel-by-z10` is installed on
  `Dzithendo31/payme`; it reviewed test PR #12 end to end (4 inline comments, ~9s model time).
- Secret-filling and smoke-test steps: `DEPLOY-TEST.md`. General setup: README.md.
- Unit tests (vitest, `test/`) cover the pure logic; handlers, Octokit and the Claude call are untested (need mocks).
  CI (`.github/workflows/ci.yml`) runs typecheck + tests; it does not run `sam build`.
- DLQ alarm notifies an SNS topic; email only if deployed with `--parameter-overrides AlarmEmail=...`.
- Refusal / `max_tokens` / context-window stops post a "couldn't review" notice and are not retried; other
  errors (incl. 4xx) still retry via SQS. Not done: API-level refusal fallback to another model.

## Commands
- `npm install && npm run typecheck && npm test`
- `sam build && sam deploy` (settings saved in `samconfig.toml`, which is gitignored)
- `sam logs -n ReviewWorkerFunction --stack-name sentinel-test --tail`
