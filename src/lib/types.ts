/** Message placed on the SQS queue by the webhook and consumed by the worker. */
export interface ReviewJob {
  readonly deliveryId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly headSha: string;
}

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
