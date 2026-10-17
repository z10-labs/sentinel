/** Review a PR at a commit. `kind` is optional so jobs queued before replies existed still parse. */
export interface ReviewJob {
  readonly kind?: "review";
  readonly deliveryId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly headSha: string;
}

/** Re-evaluate a Sentinel review comment after a human replied in its thread. */
export interface ReplyJob {
  readonly kind: "reply";
  readonly deliveryId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  /** The human's reply that triggered this job. */
  readonly commentId: number;
  /** The comment it replied to, normally the thread's first comment. */
  readonly inReplyToId: number;
}

/** Message placed on the SQS queue by the webhook and consumed by the worker. */
export type QueueJob = ReviewJob | ReplyJob;

export type Severity = "critical" | "warning" | "suggestion";

export interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly severity: Severity;
  readonly body: string;
}

export interface ReviewResult {
  readonly summary: string;
  readonly comments: readonly ReviewComment[];
}

/** Why a review can never succeed for this commit, so retrying would only cost money. */
export type UnreviewableReason = "refusal" | "max_tokens" | "context_window_exceeded";

/**
 * Outcome of one review request. Transient failures (network, timeouts, 429, 5xx/overloaded)
 * are thrown instead, so SQS retries them.
 */
export type ReviewOutcome =
  | { readonly kind: "reviewed"; readonly review: ReviewResult }
  | {
      readonly kind: "unreviewable";
      readonly reason: UnreviewableReason;
      readonly stopReason: string;
      readonly refusalCategory: string | null;
    };

/** A changed file prepared for the model, with the lines GitHub will accept comments on. */
export interface DiffFile {
  readonly path: string;
  readonly annotatedPatch: string;
  readonly commentableLines: ReadonlySet<number>;
}

/** The parts of a PR review the worker reads. */
export interface PullReview {
  readonly user: { readonly login: string } | null;
  readonly body: string | null;
  readonly submitted_at?: string | null;
}

/** What postReview created: the review, and whether its comments landed inline. */
export interface PostedReview {
  readonly reviewId: number;
  readonly inlinePosted: boolean;
}

/** Where a PR lives; enough to list or post on it. */
export type PullRef = Pick<ReviewJob, "owner" | "repo" | "pullNumber">;
