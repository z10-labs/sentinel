import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import type { Octokit } from "octokit";
import { modelId } from "./lib/claude.js";
import { selectReviewableFiles } from "./lib/diff.js";
import {
  getBotLogin,
  getInstallationClient,
  hasReviewForCommit,
  listChangedFiles,
  listReviewCommentsForReview,
  listReviews,
  partitionComments,
  postReview,
  postUnreviewableNotice,
} from "./lib/github.js";
import { loadRepoGuidance } from "./lib/guidance.js";
import {
  anchorToPullRequest,
  collectPriorComments,
  formatPriorComments,
  hasReviewSignal,
  lastReviewedSha,
  planReviewScope,
  type ReviewScope,
} from "./lib/incremental.js";
import { logger } from "./lib/logger.js";
import { recordPostedComments } from "./lib/outcomes.js";
import { requestReview } from "./lib/reviewer.js";
import { listReviewComments } from "./lib/threads.js";
import type { PostedReview, QueueJob, ReviewJob } from "./lib/types.js";
import { answerReply } from "./reply.js";

/** The bot's earlier comments, formatted for a follow-up review's prompt. Empty on a first review. */
async function loadPriorComments(
  octokit: Octokit,
  job: ReviewJob,
  scope: ReviewScope,
  trust: { botLogin: string; prAuthor: string | undefined },
): Promise<string> {
  if (scope.kind !== "incremental") return "";
  return formatPriorComments(collectPriorComments(await listReviewComments(octokit, job), trust));
}

/** Stores the inline comments of a posted review for outcome tracking. */
async function trackPostedReview(octokit: Octokit, job: ReviewJob, posted: PostedReview, followUp: boolean): Promise<void> {
  if (!posted.inlinePosted) return;
  try {
    const comments = await listReviewCommentsForReview(octokit, job, posted.reviewId);
    await recordPostedComments(job, comments, { headSha: job.headSha, model: modelId(), followUp });
  } catch (error: unknown) {
    // The review is already on the PR; a retry would only skip it as a duplicate.
    logger.error("Could not list posted comments for outcome tracking", error, { pr: job.pullNumber });
  }
}

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
  const [reviews, botLogin, prFiles] = await Promise.all([
    listReviews(octokit, job),
    getBotLogin(),
    listChangedFiles(octokit, job),
  ]);
  if (hasReviewForCommit(reviews, job.headSha)) {
    logger.info("Already reviewed this commit", context);
    return;
  }

  const scope = await planReviewScope(octokit, job, { previousSha: lastReviewedSha(reviews, botLogin), prFiles });
  const sinceSha = scope.kind === "incremental" ? scope.sinceSha : undefined;
  const selection = selectReviewableFiles(scope.files);
  const skipped = selection.skipped;
  const included = scope.kind === "incremental" ? anchorToPullRequest(selection.included, prFiles) : selection.included;
  if (included.length === 0) {
    logger.info("No reviewable files", { ...context, scope: scope.kind, changedFiles: scope.files.length });
    return;
  }
  // A push that only touches tests or generated files doesn't need another review.
  if (scope.kind === "incremental" && !hasReviewSignal(included.map((file) => file.path))) {
    logger.info("Only tests or generated files changed since the last review", { ...context, sinceSha });
    return;
  }

  // Read from the default branch so the PR under review can't rewrite its own instructions.
  const [guidance, priorComments] = await Promise.all([
    loadRepoGuidance(octokit, { owner: job.owner, repo: job.repo, defaultBranch: pullRequest.base.repo.default_branch }),
    loadPriorComments(octokit, job, scope, { botLogin, prAuthor: pullRequest.user?.login }),
  ]);

  const startedAt = Date.now();
  const outcome = await requestReview({
    title: pullRequest.title,
    description: pullRequest.body ?? "",
    files: included,
    skippedFiles: skipped,
    guidance,
    sinceSha,
    priorComments,
  });

  // Permanent failure: tell the PR once and return normally so SQS doesn't retry a doomed job.
  if (outcome.kind === "unreviewable") {
    await postUnreviewableNotice(octokit, job, outcome.reason);
    logger.warn("Review not possible, posted notice", {
      ...context,
      headSha: job.headSha,
      reason: outcome.reason,
      stopReason: outcome.stopReason,
      refusalCategory: outcome.refusalCategory,
      filesReviewed: included.length,
      modelMs: Date.now() - startedAt,
    });
    return;
  }

  const { review } = outcome;
  const { inline, general } = partitionComments(review.comments, included);

  const posted = await postReview(octokit, job, { summary: review.summary, inline, general, skippedFiles: skipped, sinceSha });
  await trackPostedReview(octokit, job, posted, scope.kind === "incremental");
  logger.info("Posted review", {
    ...context,
    scope: scope.kind,
    sinceSha,
    filesReviewed: included.length,
    filesSkipped: skipped.length,
    inlineComments: inline.length,
    generalComments: general.length,
    priorCommentsChars: priorComments.length,
    guidancePath: guidance?.path,
    modelMs: Date.now() - startedAt,
  });
}

async function processRecord(record: SQSRecord): Promise<void> {
  const job = JSON.parse(record.body) as QueueJob;
  if (job.kind === "reply") {
    await answerReply(job);
    return;
  }
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
