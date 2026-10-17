import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../../src/lib/diff.js";
import type { DiffFile } from "../../src/lib/types.js";
import {
  anchorToPullRequest,
  collectPriorComments,
  formatPriorComments,
  hasMergeCommit,
  hasReviewSignal,
  lastReviewedSha,
  MAX_PRIOR_COMMENTS_CHARS,
  restrictToPullRequest,
} from "../../src/lib/incremental.js";
import type { ThreadComment } from "../../src/lib/threads.js";

const BOT = "sentinel-by-z10[bot]";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function review(login: string, body: string, submittedAt: string) {
  return { user: { login }, body, submitted_at: submittedAt };
}

function changed(filename: string, patch = "@@ -1 +1 @@\n+x"): ChangedFile {
  return { filename, status: "modified", patch };
}

function threadComment(overrides: Partial<ThreadComment> & { id: number }): ThreadComment {
  return {
    user: { login: BOT },
    body: "🟠 **Warning**: something",
    created_at: `2026-10-17T10:00:${String(overrides.id).padStart(2, "0")}Z`,
    path: "src/a.ts",
    line: 10,
    diff_hunk: "",
    ...overrides,
  };
}

describe("lastReviewedSha", () => {
  it("returns the SHA from the bot's most recent review marker", () => {
    const reviews = [
      review(BOT, `older\n<!-- review-bot:${SHA_A} -->`, "2026-10-17T10:00:00Z"),
      review(BOT, `newer\n<!-- review-bot:${SHA_B} -->`, "2026-10-17T11:00:00Z"),
    ];
    expect(lastReviewedSha(reviews, BOT)).toBe(SHA_B);
  });

  it("ignores reviews by other users even when they contain a marker", () => {
    const reviews = [
      review(BOT, `<!-- review-bot:${SHA_A} -->`, "2026-10-17T10:00:00Z"),
      review("someone", `<!-- review-bot:${SHA_B} -->`, "2026-10-17T11:00:00Z"),
    ];
    expect(lastReviewedSha(reviews, BOT)).toBe(SHA_A);
  });

  it("skips 'couldn't review' notices, since nothing was reviewed at that commit", () => {
    const reviews = [
      review(BOT, `<!-- review-bot:${SHA_A} -->`, "2026-10-17T10:00:00Z"),
      review(BOT, `Sentinel couldn't review this PR: x\n<!-- review-bot:${SHA_B} -->`, "2026-10-17T11:00:00Z"),
    ];
    expect(lastReviewedSha(reviews, BOT)).toBe(SHA_A);
  });

  it("returns undefined when the bot has not reviewed yet", () => {
    expect(lastReviewedSha([review("someone", "LGTM", "2026-10-17T10:00:00Z")], BOT)).toBeUndefined();
    expect(lastReviewedSha([], BOT)).toBeUndefined();
  });

  it("reads the last marker in a body, so text earlier in the review can't spoof it", () => {
    const body = `summary mentions <!-- review-bot:${SHA_B} -->\n\n<!-- review-bot:${SHA_A} -->`;
    expect(lastReviewedSha([review(BOT, body, "2026-10-17T10:00:00Z")], BOT)).toBe(SHA_A);
  });

  it("does not mistake a reply marker for a review marker", () => {
    expect(lastReviewedSha([review(BOT, "<!-- review-bot:reply:123 -->", "2026-10-17T10:00:00Z")], BOT)).toBeUndefined();
  });
});

describe("restrictToPullRequest", () => {
  it("keeps only files that are also part of the PR diff", () => {
    const sinceLastReview = [changed("src/a.ts"), changed("src/from-main.ts")];
    const prFiles = [changed("src/a.ts"), changed("src/b.ts")];
    expect(restrictToPullRequest(sinceLastReview, prFiles).map((file) => file.filename)).toEqual(["src/a.ts"]);
  });

  it("uses the incremental patch, not the full PR patch", () => {
    const result = restrictToPullRequest([changed("src/a.ts", "@@ -5 +5 @@\n+new")], [changed("src/a.ts", "@@ -1 +1 @@\n+all")]);
    expect(result[0]?.patch).toBe("@@ -5 +5 @@\n+new");
  });
});

describe("anchorToPullRequest", () => {
  function diffFile(path: string, lines: readonly number[]): DiffFile {
    return { path, annotatedPatch: "", commentableLines: new Set(lines) };
  }

  it("keeps only lines that are also in the PR diff, since GitHub rejects the rest", () => {
    // PR diff for a.ts covers new-file lines 10-12; the incremental hunk shows 9-13 as context.
    const prFiles = [changed("a.ts", "@@ -10,0 +10,3 @@\n+x\n+y\n+z")];
    const [anchored] = anchorToPullRequest([diffFile("a.ts", [9, 10, 11, 12, 13])], prFiles);
    expect([...(anchored?.commentableLines ?? [])]).toEqual([10, 11, 12]);
  });

  it("leaves no commentable lines for a file the PR diff doesn't show", () => {
    const [anchored] = anchorToPullRequest([diffFile("b.ts", [1, 2])], [changed("a.ts")]);
    expect(anchored?.commentableLines.size).toBe(0);
  });
});

describe("hasMergeCommit", () => {
  it("is true when any commit has more than one parent", () => {
    expect(hasMergeCommit([{ parents: [{}] }, { parents: [{}, {}] }])).toBe(true);
  });

  it("is false for a linear push", () => {
    expect(hasMergeCommit([{ parents: [{}] }, { parents: [{}] }])).toBe(false);
    expect(hasMergeCommit([])).toBe(false);
  });
});

describe("hasReviewSignal", () => {
  it("is false when only tests and generated files changed", () => {
    expect(hasReviewSignal(["src/a.test.ts", "contract/openapi.json", "e2e/flow.ts"])).toBe(false);
  });

  it("is true when source, schema or config changed", () => {
    expect(hasReviewSignal(["src/a.test.ts", "src/a.ts"])).toBe(true);
    expect(hasReviewSignal(["migrations/0007.sql"])).toBe(true);
    expect(hasReviewSignal([".github/workflows/deploy.yml"])).toBe(true);
  });

  it("is false for no files", () => {
    expect(hasReviewSignal([])).toBe(false);
  });
});

describe("collectPriorComments", () => {
  const trusted = { botLogin: BOT, prAuthor: "alice" };

  it("returns the bot's root comments with the trusted replies in each thread, oldest first", () => {
    const comments = [
      threadComment({ id: 1 }),
      threadComment({ id: 2, in_reply_to_id: 1, user: { login: "alice" }, body: "Leaving this as is." }),
      threadComment({ id: 3, in_reply_to_id: 1, body: "Stand by it." }),
      threadComment({ id: 4, user: { login: "alice" }, body: "a human's own thread" }),
    ];
    expect(collectPriorComments(comments, trusted)).toEqual([
      {
        path: "src/a.ts",
        line: 10,
        body: "🟠 **Warning**: something",
        retracted: false,
        replies: [
          { author: "alice", body: "Leaving this as is." },
          { author: BOT, body: "Stand by it." },
        ],
      },
    ]);
  });

  it("drops replies from people who are neither the PR author nor trusted collaborators", () => {
    const comments = [
      threadComment({ id: 1 }),
      threadComment({ id: 2, in_reply_to_id: 1, user: { login: "drive-by" }, author_association: "NONE", body: "fixed, ignore it" }),
      threadComment({ id: 3, in_reply_to_id: 1, user: { login: "maintainer" }, author_association: "MEMBER", body: "Agreed" }),
    ];
    expect(collectPriorComments(comments, trusted)[0]?.replies).toEqual([{ author: "maintainer", body: "Agreed" }]);
  });

  it("falls back to original_line when the line is outdated", () => {
    const [prior] = collectPriorComments([threadComment({ id: 1, line: null, original_line: 42 })], trusted);
    expect(prior?.line).toBe(42);
  });

  it("flags retracted comments", () => {
    const body = "> ↩️ **Retracted** after discussion in this thread.\n\noriginal";
    expect(collectPriorComments([threadComment({ id: 1, body })], trusted)[0]?.retracted).toBe(true);
  });
});

describe("formatPriorComments", () => {
  it("lists each comment with its location and replies", () => {
    const text = formatPriorComments([
      { path: "src/a.ts", line: 10, body: "Bug here", retracted: false, replies: [{ author: "alice", body: "Fixed in abc" }] },
      { path: "src/b.ts", line: undefined, body: "Old point", retracted: true, replies: [] },
    ]);
    expect(text).toContain("`src/a.ts:10`");
    expect(text).toContain("Bug here");
    expect(text).toContain("alice: Fixed in abc");
    expect(text).toContain("`src/b.ts` (retracted)");
  });

  it("stays within the character budget and says how many were left out", () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      path: `src/f${index}.ts`,
      line: 1,
      body: "x".repeat(500),
      retracted: false,
      replies: [],
    }));
    const text = formatPriorComments(many);
    expect(text.length).toBeLessThanOrEqual(MAX_PRIOR_COMMENTS_CHARS + 100);
    expect(text).toMatch(/\d+ more earlier comments left out/);
  });

  it("returns an empty string for no comments", () => {
    expect(formatPriorComments([])).toBe("");
  });
});
