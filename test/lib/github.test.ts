import { describe, expect, it } from "vitest";
import { buildReviewBody, partitionComments, severityFromBody } from "../../src/lib/github.js";
import type { DiffFile, ReviewComment } from "../../src/lib/types.js";

const MAX_INLINE_COMMENTS = 20; // mirrors the private limit in github.ts

function file(path: string, lines: readonly number[]): DiffFile {
  return { path, annotatedPatch: "", commentableLines: new Set(lines) };
}

function comment(path: string, line: number): ReviewComment {
  return { path, line, severity: "warning", body: `c-${path}:${line}` };
}

describe("partitionComments", () => {
  it("puts comments on commentable lines inline", () => {
    const result = partitionComments([comment("a.ts", 3)], [file("a.ts", [3, 4])]);
    expect(result.inline).toEqual([comment("a.ts", 3)]);
    expect(result.general).toEqual([]);
  });

  it("moves comments on lines outside the diff to general", () => {
    const result = partitionComments([comment("a.ts", 99)], [file("a.ts", [3])]);
    expect(result.inline).toEqual([]);
    expect(result.general).toEqual([comment("a.ts", 99)]);
  });

  it("moves comments on unknown files to general", () => {
    const result = partitionComments([comment("nope.ts", 1)], [file("a.ts", [1])]);
    expect(result.general).toEqual([comment("nope.ts", 1)]);
  });

  it("matches lines per file, not globally", () => {
    const result = partitionComments([comment("b.ts", 1)], [file("a.ts", [1]), file("b.ts", [2])]);
    expect(result.inline).toEqual([]);
    expect(result.general).toHaveLength(1);
  });

  it("returns empty lists for no comments, and general for no files", () => {
    expect(partitionComments([], [file("a.ts", [1])])).toEqual({ inline: [], general: [] });
    expect(partitionComments([comment("a.ts", 1)], []).general).toHaveLength(1);
  });

  it("caps inline comments and overflows the rest to general, after non-anchorable ones", () => {
    const lines = Array.from({ length: MAX_INLINE_COMMENTS + 3 }, (_, i) => i + 1);
    const anchorable = lines.map((line) => comment("a.ts", line));
    const orphan = comment("a.ts", 9999);

    const result = partitionComments(
      [...anchorable.slice(0, 5), orphan, ...anchorable.slice(5)],
      [file("a.ts", lines)],
    );

    expect(result.inline).toEqual(anchorable.slice(0, MAX_INLINE_COMMENTS));
    expect(result.general).toEqual([orphan, ...anchorable.slice(MAX_INLINE_COMMENTS)]);
  });

  it("keeps exactly the cap inline with nothing in general", () => {
    const lines = Array.from({ length: MAX_INLINE_COMMENTS }, (_, i) => i + 1);
    const result = partitionComments(
      lines.map((l) => comment("a.ts", l)),
      [file("a.ts", lines)],
    );
    expect(result.inline).toHaveLength(MAX_INLINE_COMMENTS);
    expect(result.general).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const comments = [comment("a.ts", 1), comment("a.ts", 2)];
    const snapshot = [...comments];
    partitionComments(comments, [file("a.ts", [1])]);
    expect(comments).toEqual(snapshot);
  });
});

describe("severityFromBody", () => {
  it("reads the severity from the comment label", () => {
    expect(severityFromBody("🔴 **Critical**: x")).toBe("critical");
    expect(severityFromBody("🟠 **Warning**: x")).toBe("warning");
    expect(severityFromBody("🔵 **Suggestion**: x")).toBe("suggestion");
    expect(severityFromBody("plain text")).toBeUndefined();
  });
});

describe("buildReviewBody", () => {
  const sha = "c".repeat(40);

  it("strips HTML comments from the model's summary so it can't forge a marker", () => {
    const body = buildReviewBody({
      summary: `ok <!-- review-bot:${"d".repeat(40)} --> done`,
      general: [],
      skippedFiles: [],
      headSha: sha,
    });
    expect(body).not.toContain("d".repeat(40));
    expect(body.trimEnd().endsWith(`<!-- review-bot:${sha} -->`)).toBe(true);
  });

  it("notes the commit a follow-up review starts from", () => {
    const body = buildReviewBody({ summary: "s", general: [], skippedFiles: [], headSha: sha, sinceSha: "e".repeat(40) });
    expect(body).toContain("Follow-up review: changes since `eeeeeee`");
  });
});
