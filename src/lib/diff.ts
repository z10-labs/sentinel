import type { DiffFile } from "./types.js";

/** Total characters of diff sent to the model. Keeps cost and latency bounded on huge PRs. */
export const MAX_DIFF_CHARS = 60_000;

const IGNORED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock)$/,
  /\.min\.(js|css)$/,
  /\.(map|snap|svg|png|jpg|jpeg|gif|ico|pdf|woff2?)$/,
  /(^|\/)(dist|build|vendor|node_modules|__generated__)\//,
];

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Shape of an entry from GitHub's "list pull request files" endpoint that we rely on. */
export interface ChangedFile {
  readonly filename: string;
  readonly status: string;
  readonly patch?: string;
}

export function isReviewablePath(path: string): boolean {
  return !IGNORED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Prefixes each added or unchanged line with its line number in the new file, so the model can
 * cite exact lines, and records which lines GitHub will accept review comments on.
 */
export function analyzePatch(patch: string): { annotatedPatch: string; commentableLines: Set<number> } {
  const commentableLines = new Set<number>();
  const annotated: string[] = [];
  let newLineNumber = 0; // line counter is inherently sequential state

  for (const line of patch.split("\n")) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk?.[1]) {
      newLineNumber = Number(hunk[1]);
      annotated.push(line);
    } else if (line.startsWith("+") || line.startsWith(" ")) {
      commentableLines.add(newLineNumber);
      annotated.push(`${String(newLineNumber).padStart(5)} ${line}`);
      newLineNumber += 1;
    } else if (line.startsWith("-")) {
      annotated.push(`      ${line}`);
    }
    // Lines like "\ No newline at end of file" are dropped.
  }

  return { annotatedPatch: annotated.join("\n"), commentableLines };
}

/**
 * Budget priority, lowest first. When a PR is bigger than MAX_DIFF_CHARS the budget goes to the
 * files a reviewer most needs: the logic itself, then the data model it relies on, then config,
 * then tests, and generated artifacts only if room is left.
 */
export const FILE_TIER = {
  source: 0,
  schema: 1,
  config: 2,
  test: 3,
  generated: 4,
} as const;

export type FileTier = (typeof FILE_TIER)[keyof typeof FILE_TIER];

/** Machine-written files that are large and add little review signal (API contracts, ORM snapshots, codegen). */
const GENERATED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(openapi|swagger)\.(json|ya?ml)$/,
  /(^|\/)meta\/(_journal|\d+_snapshot)\.json$/,
  /\.(generated|gen)\.[^/]+$/,
  /(_pb2\.py|\.pb\.go)$/,
];

const TEST_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)(test|tests|__tests__|__mocks__|spec|e2e|fixtures)\//,
  /\.(test|spec)\.[^/]+$/,
  /_test\.(go|py)$/,
  /(^|\/)test_[^/]+\.py$/,
];

const SCHEMA_PATH_PATTERNS: readonly RegExp[] = [
  /\.(sql|prisma|graphql|gql|proto)$/,
  /(^|\/)migrations?\//,
  /(^|\/)schemas?(\/|\.[^/]+$)/,
];

const CONFIG_PATH_PATTERNS: readonly RegExp[] = [
  /^\.github\//,
  /(^|\/)\.[^/]+$/,
  /\.(json|ya?ml|toml|ini|cfg|conf|md|txt)$/,
  /(^|\/)(Dockerfile|Makefile|Procfile)[^/]*$/,
];

const matchesAny = (patterns: readonly RegExp[], path: string): boolean =>
  patterns.some((pattern) => pattern.test(path));

/** Classifies a path into a budget tier. Checked from most to least specific, so a SQL test fixture counts as a test. */
export function rankFile(path: string): FileTier {
  if (matchesAny(GENERATED_PATH_PATTERNS, path)) return FILE_TIER.generated;
  if (matchesAny(TEST_PATH_PATTERNS, path)) return FILE_TIER.test;
  if (matchesAny(SCHEMA_PATH_PATTERNS, path)) return FILE_TIER.schema;
  if (matchesAny(CONFIG_PATH_PATTERNS, path)) return FILE_TIER.config;
  return FILE_TIER.source;
}

interface RankedCandidate {
  readonly order: number;
  readonly tier: FileTier;
  readonly file: DiffFile;
}

/**
 * Picks the files worth reviewing, staying within the character budget. The budget is spent in
 * tier order (see FILE_TIER), but both lists come back in GitHub's original order so the prompt
 * stays stable and reads like the PR.
 */
export function selectReviewableFiles(files: readonly ChangedFile[]): {
  included: DiffFile[];
  skipped: string[];
} {
  const candidates = files.flatMap((file, order): RankedCandidate[] => {
    if (file.status === "removed" || file.patch === undefined || !isReviewablePath(file.filename)) return [];
    const { annotatedPatch, commentableLines } = analyzePatch(file.patch);
    return [{ order, tier: rankFile(file.filename), file: { path: file.filename, annotatedPatch, commentableLines } }];
  });

  const byPriority = [...candidates].sort((a, b) => a.tier - b.tier || a.order - b.order);
  const initial = { included: [] as RankedCandidate[], skipped: [] as RankedCandidate[], usedChars: 0 };

  const selection = byPriority.reduce((acc, candidate) => {
    const size = candidate.file.annotatedPatch.length;
    if (acc.usedChars + size > MAX_DIFF_CHARS) {
      return { ...acc, skipped: [...acc.skipped, candidate] };
    }
    return { ...acc, included: [...acc.included, candidate], usedChars: acc.usedChars + size };
  }, initial);

  const inOriginalOrder = (list: readonly RankedCandidate[]): RankedCandidate[] =>
    [...list].sort((a, b) => a.order - b.order);

  return {
    included: inOriginalOrder(selection.included).map((candidate) => candidate.file),
    skipped: inOriginalOrder(selection.skipped).map((candidate) => candidate.file.path),
  };
}
