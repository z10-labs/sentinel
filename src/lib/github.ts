import { App, type Octokit } from "octokit";
import { loadSecrets } from "./config.js";
import type { ChangedFile } from "./diff.js";
import { logger } from "./logger.js";
import type { DiffFile, ReviewComment, ReviewJob, Severity, UnreviewableReason } from "./types.js";

const MAX_INLINE_COMMENTS = 20;
const HTTP_UNPROCESSABLE = 422;

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "🔴 **Critical**",
  warning: "🟠 **Warning**",
  suggestion: "🔵 **Suggestion**",
};

let cachedApp: App | undefined;

async function getApp(): Promise<App> {
  if (!cachedApp) {
    const { githubAppId, githubPrivateKey } = await loadSecrets();
    cachedApp = new App({ appId: githubAppId, privateKey: githubPrivateKey });
  }
  return cachedApp;
}

/** An Octokit client authenticated as the app's installation on this repo's account. */
export async function getInstallationClient(installationId: number): Promise<Octokit> {
  const app = await getApp();
  return app.getInstallationOctokit(installationId);
}

/** Hidden marker in the review body so a retried job doesn't post a second review for the same commit. */
function reviewMarker(headSha: string): string {
  return `<!-- review-bot:${headSha} -->`;
}

export async function hasExistingReview(octokit: Octokit, job: ReviewJob): Promise<boolean> {
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner: job.owner,
    repo: job.repo,
    pull_number: job.pullNumber,
    per_page: 100,
  });
  const marker = reviewMarker(job.headSha);
  return reviews.some((review) => review.body?.includes(marker));
}

export async function listChangedFiles(octokit: Octokit, job: ReviewJob): Promise<ChangedFile[]> {
  return octokit.paginate(octokit.rest.pulls.listFiles, {
    owner: job.owner,
    repo: job.repo,
    pull_number: job.pullNumber,
    per_page: 100,
  });
}

/** Splits comments into ones GitHub can anchor to a diff line and ones that belong in the summary. */
export function partitionComments(
  comments: readonly ReviewComment[],
  files: readonly DiffFile[],
): { inline: ReviewComment[]; general: ReviewComment[] } {
  const linesByPath = new Map(files.map((file) => [file.path, file.commentableLines]));
  const isAnchorable = (comment: ReviewComment) => linesByPath.get(comment.path)?.has(comment.line) ?? false;

  const anchorable = comments.filter(isAnchorable);
  return {
    inline: anchorable.slice(0, MAX_INLINE_COMMENTS),
    general: [...comments.filter((comment) => !isAnchorable(comment)), ...anchorable.slice(MAX_INLINE_COMMENTS)],
  };
}

function formatComment(comment: ReviewComment): string {
  return `${SEVERITY_LABELS[comment.severity]}: ${comment.body}`;
}

function buildReviewBody(params: {
  summary: string;
  general: readonly ReviewComment[];
  skippedFiles: readonly string[];
  headSha: string;
}): string {
  const generalSection =
    params.general.length > 0
      ? `### Other notes\n${params.general
          .map((comment) => `- \`${comment.path}:${comment.line}\` ${formatComment(comment)}`)
          .join("\n")}`
      : "";
  const skippedSection =
    params.skippedFiles.length > 0
      ? `<details><summary>${params.skippedFiles.length} files not reviewed (diff too large)</summary>\n\n${params.skippedFiles
          .map((path) => `- \`${path}\``)
          .join("\n")}\n</details>`
      : "";

  return [
    "## 🤖 Automated review",
    params.summary,
    generalSection,
    skippedSection,
    "_Automated feedback. It can be wrong, so use your judgement._",
    reviewMarker(params.headSha),
  ]
    .filter(Boolean)
    .join("\n\n");
}

const UNREVIEWABLE_EXPLANATIONS: Record<UnreviewableReason, string> = {
  refusal: "the model declined to review this diff.",
  max_tokens: "the review ran past the model's output limit.",
  context_window_exceeded: "the diff is too large for the model's context window.",
};

/** Body of the notice posted when a PR can't be reviewed. Carries the marker so redelivery doesn't repost. */
export function buildUnreviewableBody(reason: UnreviewableReason, headSha: string): string {
  return [
    "## 🤖 Automated review",
    `Sentinel couldn't review this PR: ${UNREVIEWABLE_EXPLANATIONS[reason]} It won't retry for this commit; a new push will trigger a fresh attempt.`,
    reviewMarker(headSha),
  ].join("\n\n");
}

export async function postUnreviewableNotice(
  octokit: Octokit,
  job: ReviewJob,
  reason: UnreviewableReason,
): Promise<void> {
  await octokit.rest.pulls.createReview({
    owner: job.owner,
    repo: job.repo,
    pull_number: job.pullNumber,
    commit_id: job.headSha,
    event: "COMMENT",
    body: buildUnreviewableBody(reason, job.headSha),
  });
}

export async function postReview(
  octokit: Octokit,
  job: ReviewJob,
  review: {
    summary: string;
    inline: readonly ReviewComment[];
    general: readonly ReviewComment[];
    skippedFiles: readonly string[];
  },
): Promise<void> {
  const baseRequest = {
    owner: job.owner,
    repo: job.repo,
    pull_number: job.pullNumber,
    commit_id: job.headSha,
    event: "COMMENT" as const,
  };

  try {
    await octokit.rest.pulls.createReview({
      ...baseRequest,
      body: buildReviewBody({ ...review, headSha: job.headSha }),
      comments: review.inline.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: "RIGHT" as const,
        body: formatComment(comment),
      })),
    });
  } catch (error: unknown) {
    // 422 usually means GitHub rejected a line anchor. Fall back to one review with everything in the body.
    const status = (error as { status?: number }).status;
    if (status !== HTTP_UNPROCESSABLE) throw error;

    logger.warn("Inline comments rejected, posting summary-only review", { deliveryId: job.deliveryId });
    await octokit.rest.pulls.createReview({
      ...baseRequest,
      body: buildReviewBody({
        ...review,
        general: [...review.inline, ...review.general],
        headSha: job.headSha,
      }),
    });
  }
}
