import { getBotLogin, getInstallationClient } from "./lib/github.js";
import { loadRepoGuidance } from "./lib/guidance.js";
import { logger } from "./lib/logger.js";
import { classifyHumanReply, recordReply } from "./lib/outcomes.js";
import { formatReplyBody, type ReplyVerdict, requestReply } from "./lib/replier.js";
import {
  decideReply,
  fetchFileExcerpt,
  listReviewComments,
  markRetracted,
  postThreadReply,
  replyMarker,
  selectThread,
} from "./lib/threads.js";
import type { ThreadComment } from "./lib/threads.js";
import type { ReplyJob } from "./lib/types.js";

/**
 * Records the human's reply on the bot comment it answers. Called before the reply limit or a model
 * failure can skip the job, and again with the bot's verdict once it has replied.
 */
async function trackHumanReply(
  job: ReplyJob,
  thread: readonly ThreadComment[],
  botLogin: string,
  verdict?: ReplyVerdict,
): Promise<void> {
  const [root] = thread;
  const trigger = thread.find((comment) => comment.id === job.commentId);
  if (!root || !trigger || root.user?.login !== botLogin || trigger.user?.login === botLogin) return;
  await recordReply(job, root.id, {
    replyClass: classifyHumanReply(trigger.body),
    replyBody: trigger.body,
    replyAuthor: trigger.user?.login ?? "unknown",
    root,
    verdict,
  });
}

/**
 * Answers a human's reply to one of the bot's review comments: Claude re-reads the code and the
 * thread, then stands by, revises or retracts its point. A retraction also marks the original comment.
 */
export async function answerReply(job: ReplyJob): Promise<void> {
  const context = { deliveryId: job.deliveryId, repo: `${job.owner}/${job.repo}`, pr: job.pullNumber, commentId: job.commentId };
  const octokit = await getInstallationClient(job.installationId);

  const [botLogin, { data: pullRequest }, comments] = await Promise.all([
    getBotLogin(),
    octokit.rest.pulls.get({ owner: job.owner, repo: job.repo, pull_number: job.pullNumber }),
    listReviewComments(octokit, job),
  ]);

  if (pullRequest.state !== "open") {
    logger.info("Skipping reply on a closed PR", context);
    return;
  }

  const thread = selectThread(comments, job.inReplyToId);
  await trackHumanReply(job, thread, botLogin);
  const decision = decideReply({ thread, triggerCommentId: job.commentId, botLogin });
  const [root] = thread;
  if (decision.action === "skip" || !root) {
    logger.info("Not replying", { ...context, reason: decision.action === "skip" ? decision.reason : "no root" });
    return;
  }

  const line = root.line ?? root.original_line ?? undefined;
  const [guidance, currentExcerpt] = await Promise.all([
    loadRepoGuidance(octokit, { owner: job.owner, repo: job.repo, defaultBranch: pullRequest.base.repo.default_branch }),
    line === undefined
      ? Promise.resolve(undefined)
      : fetchFileExcerpt(octokit, { owner: job.owner, repo: job.repo, path: root.path, ref: pullRequest.head.sha, line }),
  ]);

  const startedAt = Date.now();
  const outcome = await requestReply({
    prTitle: pullRequest.title,
    path: root.path,
    line,
    diffHunk: root.diff_hunk,
    currentExcerpt,
    thread: thread.map((comment) => ({
      author: comment.user?.login ?? "unknown",
      isBot: comment.user?.login === botLogin,
      body: comment.body,
    })),
    guidance,
  });

  // A refusal or cut-off won't change on retry. Stay silent in the thread rather than post noise.
  if (outcome.kind === "unreviewable") {
    logger.warn("Could not re-evaluate comment", { ...context, reason: outcome.reason, stopReason: outcome.stopReason });
    return;
  }

  const { verdict } = outcome.value;
  // Retract first: it's idempotent, while the reply's marker ends retries. The other order could
  // leave a retraction unmarked if the edit failed after the reply posted.
  if (verdict === "retract") await markRetracted(octokit, job, root);
  await postThreadReply(octokit, job, root.id, formatReplyBody(outcome.value, replyMarker(job.commentId)));
  await trackHumanReply(job, thread, botLogin, verdict);

  logger.info("Replied in thread", {
    ...context,
    rootCommentId: root.id,
    verdict,
    guidancePath: guidance?.path,
    modelMs: Date.now() - startedAt,
  });
}
