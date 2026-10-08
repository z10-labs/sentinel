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

/** Picks the files worth reviewing, staying within the character budget. */
export function selectReviewableFiles(files: readonly ChangedFile[]): {
  included: DiffFile[];
  skipped: string[];
} {
  const initial = { included: [] as DiffFile[], skipped: [] as string[], usedChars: 0 };

  const selection = files.reduce((acc, file) => {
    const isCandidate = file.status !== "removed" && file.patch !== undefined && isReviewablePath(file.filename);
    if (!isCandidate || file.patch === undefined) return acc;

    const { annotatedPatch, commentableLines } = analyzePatch(file.patch);
    if (acc.usedChars + annotatedPatch.length > MAX_DIFF_CHARS) {
      return { ...acc, skipped: [...acc.skipped, file.filename] };
    }
    return {
      included: [...acc.included, { path: file.filename, annotatedPatch, commentableLines }],
      skipped: acc.skipped,
      usedChars: acc.usedChars + annotatedPatch.length,
    };
  }, initial);

  return { included: selection.included, skipped: selection.skipped };
}
