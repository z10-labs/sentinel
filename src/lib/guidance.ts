import type { Octokit } from "octokit";

/** Checked in order; the first file that exists wins. `.sentinel/REVIEW.md` is the dedicated one. */
export const GUIDANCE_PATHS: readonly string[] = [".sentinel/REVIEW.md", "REVIEW.md", "CLAUDE.md"];
/** Keeps a huge CLAUDE.md from crowding out the diff. */
export const MAX_GUIDANCE_CHARS = 8000;
const HTTP_NOT_FOUND = 404;

/** A repository's own review instructions, read from its default branch. */
export interface RepoGuidance {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export function trimGuidance(path: string, raw: string): RepoGuidance | undefined {
  const content = raw.trim();
  if (content === "") return undefined;
  const truncated = content.length > MAX_GUIDANCE_CHARS;
  return { path, content: truncated ? content.slice(0, MAX_GUIDANCE_CHARS) : content, truncated };
}

/** Reads one file as text at a ref, or undefined when it doesn't exist there. */
export async function fetchTextFile(
  octokit: Octokit,
  location: { owner: string; repo: string; path: string; ref: string },
): Promise<string | undefined> {
  try {
    const { data } = await octokit.rest.repos.getContent({ ...location, mediaType: { format: "raw" } });
    // With the raw media type GitHub returns the file body, not the JSON metadata the types describe.
    const body: unknown = data;
    return typeof body === "string" ? body : undefined;
  } catch (error: unknown) {
    if ((error as { status?: number }).status === HTTP_NOT_FOUND) return undefined;
    throw error;
  }
}

/**
 * Loads review guidance from the repository's default branch, never from the PR head, so a pull
 * request can't rewrite the instructions it is reviewed under.
 */
export async function loadRepoGuidance(
  octokit: Octokit,
  repo: { owner: string; repo: string; defaultBranch: string },
): Promise<RepoGuidance | undefined> {
  for (const path of GUIDANCE_PATHS) {
    const raw = await fetchTextFile(octokit, { owner: repo.owner, repo: repo.repo, path, ref: repo.defaultBranch });
    const guidance = raw === undefined ? undefined : trimGuidance(path, raw);
    if (guidance) return guidance;
  }
  return undefined;
}
