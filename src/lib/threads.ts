import type { Octokit } from "octokit";
import { fetchTextFile } from "./guidance.js";
import type { PullRef, ReplyJob } from "./types.js";

/** Bounds cost and stops an endless back-and-forth in one thread. */
export const MAX_BOT_REPLIES_PER_THREAD = 3;
/** Lines of current file content shown on each side of the commented line. */
const EXCERPT_CONTEXT_LINES = 40;
const RETRACTED_BANNER = "> ↩️ **Retracted** after discussion in this thread.";

/** Author associations whose replies the bot answers and treats as context. The PR author is trusted too. */
export const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** The parts of a pull request review comment this bot uses. */
export interface ThreadComment {
  readonly id: number;
  readonly in_reply_to_id?: number;
  readonly user: { readonly login: string; readonly type?: string } | null;
  readonly author_association?: string;
  readonly body: string;
  readonly created_at: string;
  readonly path: string;
  readonly line?: number | null;
  readonly original_line?: number | null;
  readonly diff_hunk: string;
}

export type ReplyDecision = { readonly action: "reply" } | { readonly action: "skip"; readonly reason: string };

/** Hidden marker on each bot reply, naming the comment it answers, so redelivery doesn't answer twice. */
export function replyMarker(commentId: number): string {
  return `<!-- review-bot:reply:${commentId} -->`;
}

/**
 * The thread containing `commentId`, oldest first, starting at its root comment.
 * GitHub threads are flat: every reply points at the root through in_reply_to_id.
 */
export function selectThread(comments: readonly ThreadComment[], commentId: number): ThreadComment[] {
  const target = comments.find((comment) => comment.id === commentId);
  if (!target) return [];
  const rootId = target.in_reply_to_id ?? target.id;
  return comments
    .filter((comment) => comment.id === rootId || comment.in_reply_to_id === rootId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
}

/** Decides whether a human's reply in a thread should get an answer from the bot. */
export function decideReply(params: {
  thread: readonly ThreadComment[];
  triggerCommentId: number;
  botLogin: string;
}): ReplyDecision {
  const { thread, triggerCommentId, botLogin } = params;
  const [root] = thread;
  const trigger = thread.find((comment) => comment.id === triggerCommentId);

  if (!root || !trigger) return { action: "skip", reason: "thread or reply no longer exists" };
  if (root.user?.login !== botLogin) return { action: "skip", reason: "thread was not started by the bot" };
  if (trigger.user?.login === botLogin) return { action: "skip", reason: "reply is the bot's own" };

  const botReplies = thread.filter((comment) => comment.id !== root.id && comment.user?.login === botLogin);
  if (botReplies.some((comment) => comment.body.includes(replyMarker(triggerCommentId)))) {
    return { action: "skip", reason: "already answered this reply" };
  }
  if (botReplies.length >= MAX_BOT_REPLIES_PER_THREAD) {
    return { action: "skip", reason: "reply limit for this thread reached" };
  }
  return { action: "reply" };
}

export function isRetracted(body: string): boolean {
  return body.startsWith(RETRACTED_BANNER);
}

export function retractedBody(body: string): string {
  return isRetracted(body) ? body : `${RETRACTED_BANNER}\n\n${body}`;
}

/** Lines around `line` (1-based) with their numbers, or undefined if the line is out of range. */
export function excerptAround(content: string, line: number): string | undefined {
  const lines = content.split("\n");
  if (line < 1 || line > lines.length) return undefined;
  const start = Math.max(1, line - EXCERPT_CONTEXT_LINES);
  const end = Math.min(lines.length, line + EXCERPT_CONTEXT_LINES);
  return lines
    .slice(start - 1, end)
    .map((text, index) => `${String(start + index).padStart(5)} ${text}`)
    .join("\n");
}

export async function listReviewComments(octokit: Octokit, job: PullRef): Promise<ThreadComment[]> {
  return octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner: job.owner,
    repo: job.repo,
    pull_number: job.pullNumber,
    per_page: 100,
  });
}

/** The current file around a line at the PR head, or undefined if the file or line is gone. */
export async function fetchFileExcerpt(
  octokit: Octokit,
  location: { owner: string; repo: string; path: string; ref: string; line: number },
): Promise<string | undefined> {
  const content = await fetchTextFile(octokit, location);
  return content === undefined ? undefined : excerptAround(content, location.line);
}

export async function postThreadReply(octokit: Octokit, job: ReplyJob, rootId: number, body: string): Promise<void> {
  await octokit.rest.pulls.createReplyForReviewComment({
    owner: job.owner,
    repo: job.repo,
    pull_number: job.pullNumber,
    comment_id: rootId,
    body,
  });
}

/** Marks the bot's original comment as retracted, so readers skimming the PR see it no longer stands. */
export async function markRetracted(octokit: Octokit, job: ReplyJob, root: ThreadComment): Promise<void> {
  if (isRetracted(root.body)) return;
  await octokit.rest.pulls.updateReviewComment({
    owner: job.owner,
    repo: job.repo,
    comment_id: root.id,
    body: retractedBody(root.body),
  });
}
