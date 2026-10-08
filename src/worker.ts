import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { selectReviewableFiles } from "./lib/diff.js";
import {
  getInstallationClient,
  hasExistingReview,
  listChangedFiles,
  partitionComments,
  postReview,
} from "./lib/github.js";
import { logger } from "./lib/logger.js";
import { requestReview } from "./lib/reviewer.js";
import type { ReviewJob } from "./lib/types.js";

async function reviewPullRequest(job: ReviewJob): Promise<void> {
  const context = { deliveryId: job.deliveryId, repo: `${job.owner}/${job.repo}`, pr: job.pullNumber };
  const octokit = await getInstallationClient(job.installationId);

  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner: job.owner,
    repo: job.repo,
    pull_number: job.pullNumber,
  });

  // A newer push supersedes this job; its own webhook will trigger a fresh review.
  if (pullRequest.state !== "open" || pullRequest.head.sha !== job.headSha) {
    logger.info("Skipping stale job", { ...context, currentSha: pullRequest.head.sha });
    return;
  }
  if (await hasExistingReview(octokit, job)) {
    logger.info("Already reviewed this commit", context);
    return;
  }

  const changedFiles = await listChangedFiles(octokit, job);
  const { included, skipped } = selectReviewableFiles(changedFiles);
  if (included.length === 0) {
    logger.info("No reviewable files", { ...context, changedFiles: changedFiles.length });
    return;
  }

  const startedAt = Date.now();
  const review = await requestReview({
    title: pullRequest.title,
    description: pullRequest.body ?? "",
    files: included,
    skippedFiles: skipped,
  });
  const { inline, general } = partitionComments(review.comments, included);

  await postReview(octokit, job, { summary: review.summary, inline, general, skippedFiles: skipped });
  logger.info("Posted review", {
    ...context,
    filesReviewed: included.length,
    filesSkipped: skipped.length,
    inlineComments: inline.length,
    generalComments: general.length,
    modelMs: Date.now() - startedAt,
  });
}

async function processRecord(record: SQSRecord): Promise<void> {
  const job = JSON.parse(record.body) as ReviewJob;
  await reviewPullRequest(job);
}

/**
 * SQS consumer. Failed messages are reported individually so SQS retries only those,
 * and after 3 failed attempts a message moves to the dead-letter queue.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const results = await Promise.allSettled(event.Records.map(processRecord));

  const batchItemFailures = results.flatMap((result, index) => {
    const record = event.Records[index];
    if (result.status === "fulfilled" || !record) return [];
    logger.error("Review failed", result.reason, { messageId: record.messageId });
    return [{ itemIdentifier: record.messageId }];
  });

  return { batchItemFailures };
}
