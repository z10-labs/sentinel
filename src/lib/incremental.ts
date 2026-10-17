import type { Octokit } from "octokit";
import { analyzePatch, type ChangedFile, FILE_TIER, rankFile } from "./diff.js";
import { UNREVIEWABLE_PREFIX } from "./github.js";
import { isRetracted, type ThreadComment, TRUSTED_ASSOCIATIONS } from "./threads.js";
import type { DiffFile, PullReview, ReviewJob } from "./types.js";

/** Matches the hidden review marker, not the `review-bot:reply:<id>` reply marker. */
const REVIEW_MARKER_PATTERN = /<!-- review-bot:([0-9a-f]{40}) -->/g;
/** Compare results list at most this many files; at the limit the list may be cut, so review in full. */
const COMPARE_FILE_LIMIT = 300;
/** Keeps earlier comments from crowding out the diff. */
export const MAX_PRIOR_COMMENTS_CHARS = 6000;
const MAX_PRIOR_BODY_CHARS = 600;
const MAX_PRIOR_REPLY_CHARS = 300;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE = 422;

/** One of the bot's earlier inline comments, with the discussion under it. */
export interface PriorComment {
  readonly path: string;
  readonly line: number | undefined;
  readonly body: string;
  readonly retracted: boolean;
  readonly replies: readonly { readonly author: string; readonly body: string }[];
}

/** What a review job should look at: the whole PR, or only what changed since the last reviewed commit. */
export type ReviewScope =
  | { readonly kind: "full"; readonly files: readonly ChangedFile[] }
  | { readonly kind: "incremental"; readonly sinceSha: string; readonly files: readonly ChangedFile[] };

/** The commit of the bot's most recent real review on this PR, if any. "Couldn't review" notices don't count. */
export function lastReviewedSha(reviews: readonly PullReview[], botLogin: string): string | undefined {
  const reviewed = reviews
    .filter((review) => review.user?.login === botLogin && review.body && !review.body.includes(UNREVIEWABLE_PREFIX))
    .flatMap((review) => {
      // The real marker is appended last; anything earlier is review text.
      const sha = [...(review.body ?? "").matchAll(REVIEW_MARKER_PATTERN)].at(-1)?.[1];
      return sha ? [{ sha, at: review.submitted_at ?? "" }] : [];
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  return reviewed.at(-1)?.sha;
}

/**
 * Files changed since the last review, limited to files the PR itself changes. Merging the base
 * branch into the PR shows up in the compare, but those files aren't the author's work.
 */
export function restrictToPullRequest(
  sinceLastReview: readonly ChangedFile[],
  prFiles: readonly ChangedFile[],
): ChangedFile[] {
  const prPaths = new Set(prFiles.map((file) => file.filename));
  return sinceLastReview.filter((file) => prPaths.has(file.filename));
}

/**
 * Narrows each file's commentable lines to lines GitHub accepts on this PR. A follow-up diff starts at
 * the previous review, so its context lines can fall outside the PR's own hunks; commenting there
 * makes GitHub reject the whole review (422).
 */
export function anchorToPullRequest(files: readonly DiffFile[], prFiles: readonly ChangedFile[]): DiffFile[] {
  const prLines = new Map(
    prFiles.map((file) => [file.filename, file.patch === undefined ? new Set<number>() : analyzePatch(file.patch).commentableLines]),
  );
  return files.map((file) => {
    const allowed = prLines.get(file.path) ?? new Set<number>();
    return { ...file, commentableLines: new Set([...file.commentableLines].filter((line) => allowed.has(line))) };
  });
}

/** True when the compared range contains a merge, e.g. the base branch merged into the PR. */
export function hasMergeCommit(commits: readonly { readonly parents: readonly unknown[] }[]): boolean {
  return commits.some((commit) => commit.parents.length > 1);
}

/** True when at least one path is worth a follow-up review, i.e. not only tests or generated files. */
export function hasReviewSignal(paths: readonly string[]): boolean {
  return paths.some((path) => rankFile(path) < FILE_TIER.test);
}

function isTrustedAuthor(comment: ThreadComment, trust: { botLogin: string; prAuthor: string | undefined }): boolean {
  const login = comment.user?.login;
  if (login === trust.botLogin || (login !== undefined && login === trust.prAuthor)) return true;
  return comment.author_association !== undefined && TRUSTED_ASSOCIATIONS.has(comment.author_association);
}

/**
 * The bot's root comments on the PR, each with the replies in its thread, oldest first. Only replies
 * from the bot, the PR author and trusted collaborators are kept: they go into the prompt, and on a
 * public repo anyone can reply.
 */
export function collectPriorComments(
  comments: readonly ThreadComment[],
  trust: { readonly botLogin: string; readonly prAuthor: string | undefined },
): PriorComment[] {
  const { botLogin } = trust;
  const byAge = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  return byAge
    .filter((comment) => comment.in_reply_to_id === undefined && comment.user?.login === botLogin)
    .map((root) => ({
      path: root.path,
      line: root.line ?? root.original_line ?? undefined,
      body: root.body,
      retracted: isRetracted(root.body),
      replies: byAge
        .filter((comment) => comment.in_reply_to_id === root.id && isTrustedAuthor(comment, trust))
        .map((comment) => ({ author: comment.user?.login ?? "unknown", body: comment.body })),
    }));
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function formatPriorComment(prior: PriorComment): string {
  const location = prior.line === undefined ? `\`${prior.path}\`` : `\`${prior.path}:${prior.line}\``;
  const header = `- ${location}${prior.retracted ? " (retracted)" : ""}: ${clip(prior.body, MAX_PRIOR_BODY_CHARS)}`;
  const replies = prior.replies.map((reply) => `  - ${reply.author}: ${clip(reply.body, MAX_PRIOR_REPLY_CHARS)}`);
  return [header, ...replies].join("\n");
}

/** Earlier comments as a Markdown list for the prompt, within MAX_PRIOR_COMMENTS_CHARS. */
export function formatPriorComments(priors: readonly PriorComment[]): string {
  const initial = { lines: [] as string[], used: 0, omitted: 0 };
  const packed = priors.reduce((acc, prior) => {
    const entry = formatPriorComment(prior);
    if (acc.omitted > 0 || acc.used + entry.length > MAX_PRIOR_COMMENTS_CHARS) {
      return { ...acc, omitted: acc.omitted + 1 };
    }
    return { ...acc, lines: [...acc.lines, entry], used: acc.used + entry.length + 1 };
  }, initial);

  const omittedNote = packed.omitted > 0 ? [`- (${packed.omitted} more earlier comments left out)`] : [];
  return [...packed.lines, ...omittedNote].join("\n");
}

/**
 * Decides what to review. With a previous review whose commit is an ancestor of the head, only
 * the changes since then; after a rebase or force-push, or if the compare fails, the whole PR.
 */
export async function planReviewScope(
  octokit: Octokit,
  job: ReviewJob,
  params: { readonly previousSha: string | undefined; readonly prFiles: readonly ChangedFile[] },
): Promise<ReviewScope> {
  const full: ReviewScope = { kind: "full", files: params.prFiles };
  if (!params.previousSha) return full;

  const compared = await compareCommits(octokit, job, params.previousSha);
  if (!compared || compared.status !== "ahead" || compared.files.length >= COMPARE_FILE_LIMIT) return full;
  // A merge brings in other people's changes to the same files; only a full review sees them as the PR does.
  if (hasMergeCommit(compared.commits)) return full;

  return {
    kind: "incremental",
    sinceSha: params.previousSha,
    files: restrictToPullRequest(compared.files, params.prFiles),
  };
}

async function compareCommits(
  octokit: Octokit,
  job: ReviewJob,
  baseSha: string,
): Promise<{ status: string; files: ChangedFile[]; commits: { parents: unknown[] }[] } | undefined> {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner: job.owner,
      repo: job.repo,
      basehead: `${baseSha}...${job.headSha}`,
    });
    return { status: data.status, files: data.files ?? [], commits: data.commits };
  } catch (error: unknown) {
    // The old commit can be gone after a force-push (404) or unrelated to the head (422).
    const status = (error as { status?: number }).status;
    if (status === HTTP_NOT_FOUND || status === HTTP_UNPROCESSABLE) return undefined;
    throw error;
  }
}
