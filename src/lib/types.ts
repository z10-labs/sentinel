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

/** A changed file prepared for the model, with the lines GitHub will accept comments on. */
export interface DiffFile {
  readonly path: string;
  readonly annotatedPatch: string;
  readonly commentableLines: ReadonlySet<number>;
}
