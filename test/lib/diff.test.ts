import { describe, expect, it } from "vitest";
import {
  analyzePatch,
  FILE_TIER,
  isReviewablePath,
  MAX_DIFF_CHARS,
  rankFile,
  selectReviewableFiles,
} from "../../src/lib/diff.js";

describe("isReviewablePath", () => {
  it.each(["src/index.ts", "README.md", "docs/distribution/notes.md", "src/builder/build.ts"])(
    "accepts %s",
    (path) => {
      expect(isReviewablePath(path)).toBe(true);
    },
  );

  it.each([
    "package-lock.json",
    "web/package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "go.sum",
    "app.min.js",
    "styles/site.min.css",
    "bundle.js.map",
    "logo.svg",
    "photo.png",
    "fonts/a.woff2",
    "dist/index.js",
    "packages/x/node_modules/y/index.js",
    "src/__generated__/types.ts",
  ])("rejects %s", (path) => {
    expect(isReviewablePath(path)).toBe(false);
  });

  it("does not treat a lookalike lockfile name as a lockfile", () => {
    expect(isReviewablePath("my-package-lock.json")).toBe(true);
  });
});

describe("analyzePatch", () => {
  it("numbers added and context lines from the hunk start and leaves removed lines unnumbered", () => {
    const patch = ["@@ -1,3 +10,3 @@", " keep", "-old", "+new", " tail"].join("\n");

    const { annotatedPatch, commentableLines } = analyzePatch(patch);

    expect(annotatedPatch.split("\n")).toEqual([
      "@@ -1,3 +10,3 @@",
      "   10  keep",
      "      -old",
      "   11 +new",
      "   12  tail",
    ]);
    expect([...commentableLines]).toEqual([10, 11, 12]);
  });

  it("resets numbering at each hunk header", () => {
    const patch = ["@@ -1 +1 @@", "+a", "@@ -50,2 +100,2 @@", " b", "+c"].join("\n");

    const { commentableLines } = analyzePatch(patch);

    expect([...commentableLines]).toEqual([1, 100, 101]);
  });

  it("handles hunk headers without a length (single-line hunks, new files)", () => {
    const { commentableLines } = analyzePatch("@@ -0,0 +1 @@\n+only");
    expect([...commentableLines]).toEqual([1]);
  });

  it("drops the 'No newline at end of file' marker without shifting numbers", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file"].join(
      "\n",
    );

    const { annotatedPatch, commentableLines } = analyzePatch(patch);

    expect(annotatedPatch).not.toContain("No newline");
    expect([...commentableLines]).toEqual([1]);
  });

  it("does not mark removed lines as commentable", () => {
    const { commentableLines } = analyzePatch("@@ -1,2 +1,0 @@\n-a\n-b");
    expect(commentableLines.size).toBe(0);
  });

  it("returns empty output for an empty patch", () => {
    const { annotatedPatch, commentableLines } = analyzePatch("");
    expect(annotatedPatch).toBe("");
    expect(commentableLines.size).toBe(0);
  });

  it("pads line numbers to a fixed width and keeps wider numbers intact", () => {
    const { annotatedPatch } = analyzePatch("@@ -1 +123456 @@\n+x");
    expect(annotatedPatch.split("\n")[1]).toBe("123456 +x");
  });
});

describe("selectReviewableFiles", () => {
  const patch = "@@ -1 +1 @@\n+x";

  it("includes reviewable files with their annotated patch and commentable lines", () => {
    const { included, skipped } = selectReviewableFiles([{ filename: "a.ts", status: "modified", patch }]);

    expect(skipped).toEqual([]);
    expect(included).toHaveLength(1);
    expect(included[0]?.path).toBe("a.ts");
    expect(included[0]?.annotatedPatch).toContain("    1 +x");
    expect([...(included[0]?.commentableLines ?? [])]).toEqual([1]);
  });

  it("silently filters removed files, files without a patch, and ignored paths", () => {
    const { included, skipped } = selectReviewableFiles([
      { filename: "gone.ts", status: "removed", patch },
      { filename: "binary.bin", status: "added" },
      { filename: "package-lock.json", status: "modified", patch },
      { filename: "keep.ts", status: "added", patch },
    ]);

    expect(included.map((f) => f.path)).toEqual(["keep.ts"]);
    expect(skipped).toEqual([]);
  });

  it("returns empty results for no files", () => {
    expect(selectReviewableFiles([])).toEqual({ included: [], skipped: [] });
  });

  it("skips files that would exceed the character budget but keeps later files that fit", () => {
    const bigPatch = `@@ -1 +1 @@\n+${"x".repeat(MAX_DIFF_CHARS)}`;

    const { included, skipped } = selectReviewableFiles([
      { filename: "first.ts", status: "modified", patch },
      { filename: "huge.ts", status: "modified", patch: bigPatch },
      { filename: "last.ts", status: "modified", patch },
    ]);

    expect(included.map((f) => f.path)).toEqual(["first.ts", "last.ts"]);
    expect(skipped).toEqual(["huge.ts"]);
  });

  it("accepts a file that lands exactly on the budget and rejects one char more", () => {
    const header = "@@ -1 +1 @@\n";
    // The annotated "+..." line gains a 6-char prefix ("    1 "); the header is unchanged.
    const fillerLength = MAX_DIFF_CHARS - header.length - 6 - 1;
    const exact = `${header}+${"y".repeat(fillerLength)}`;
    const over = `${exact}y`;

    expect(selectReviewableFiles([{ filename: "e.ts", status: "added", patch: exact }]).included).toHaveLength(1);
    expect(selectReviewableFiles([{ filename: "o.ts", status: "added", patch: over }]).skipped).toEqual(["o.ts"]);
  });

  it("does not mutate its input", () => {
    const files = [{ filename: "a.ts", status: "modified", patch }];
    const snapshot = structuredClone(files);
    selectReviewableFiles(files);
    expect(files).toEqual(snapshot);
  });
});

describe("rankFile", () => {
  it.each([
    ["modules/scheduling/application/ratings.ts", FILE_TIER.source],
    ["modules/scheduling/domain/session-rating.ts", FILE_TIER.source],
    ["src/index.ts", FILE_TIER.source],
    ["drizzle/0006_session_ratings.sql", FILE_TIER.schema],
    ["db/migrations/20261017_add_index.ts", FILE_TIER.schema],
    ["src/db/schema.ts", FILE_TIER.schema],
    ["src/db/schema/ratings.ts", FILE_TIER.schema],
    ["prisma/schema.prisma", FILE_TIER.schema],
    [".github/workflows/ci.yml", FILE_TIER.config],
    ["package.json", FILE_TIER.config],
    ["tsconfig.json", FILE_TIER.config],
    [".env.example", FILE_TIER.config],
    ["Dockerfile", FILE_TIER.config],
    ["README.md", FILE_TIER.config],
    ["test/ratings.test.ts", FILE_TIER.test],
    ["src/ratings.spec.ts", FILE_TIER.test],
    ["modules/scheduling/__tests__/ratings.ts", FILE_TIER.test],
    ["pkg/rate_test.go", FILE_TIER.test],
    ["tests/test_rate.py", FILE_TIER.test],
    ["test/fixtures/seed.sql", FILE_TIER.test],
    ["contract/openapi.json", FILE_TIER.generated],
    ["api/swagger.yaml", FILE_TIER.generated],
    ["drizzle/meta/_journal.json", FILE_TIER.generated],
    ["drizzle/meta/0006_snapshot.json", FILE_TIER.generated],
    ["src/client.generated.ts", FILE_TIER.generated],
    ["proto/rate.pb.go", FILE_TIER.generated],
  ])("ranks %s as tier %i", (path, tier) => {
    expect(rankFile(path)).toBe(tier);
  });

  it("does not treat lookalike names as tests or schemas", () => {
    expect(rankFile("src/testimonials.ts")).toBe(FILE_TIER.source);
    expect(rankFile("src/latest.ts")).toBe(FILE_TIER.source);
    expect(rankFile("src/schemaless.ts")).toBe(FILE_TIER.source);
  });
});

describe("selectReviewableFiles ranking", () => {
  const patchOfSize = (chars: number): string => `@@ -1 +1 @@\n+${"x".repeat(chars)}`;
  // Each "big" file uses well over half the budget, so only one of them can ever fit.
  const big = patchOfSize(Math.ceil(MAX_DIFF_CHARS * 0.6));
  const small = patchOfSize(100);

  it("spends the budget on source before a large generated contract that sorts first", () => {
    const { included, skipped } = selectReviewableFiles([
      { filename: "contract/openapi.json", status: "modified", patch: big },
      { filename: "modules/scheduling/application/ratings.ts", status: "added", patch: big },
    ]);

    expect(included.map((f) => f.path)).toEqual(["modules/scheduling/application/ratings.ts"]);
    expect(skipped).toEqual(["contract/openapi.json"]);
  });

  it("reproduces the PR #41 shape: generated contract and tests no longer push out source and migrations", () => {
    const sourceChars = Math.floor(MAX_DIFF_CHARS * 0.3);
    const testChars = Math.floor(MAX_DIFF_CHARS * 0.4);
    const { included, skipped } = selectReviewableFiles([
      { filename: "contract/openapi.json", status: "modified", patch: big },
      { filename: "drizzle/0006_session_ratings.sql", status: "added", patch: small },
      { filename: "drizzle/meta/0006_snapshot.json", status: "added", patch: big },
      { filename: "drizzle/meta/_journal.json", status: "modified", patch: small },
      { filename: "modules/scheduling/application/ratings.ts", status: "added", patch: patchOfSize(sourceChars) },
      { filename: "modules/scheduling/domain/session-rating.ts", status: "added", patch: small },
      { filename: "modules/scheduling/test/ratings.test.ts", status: "added", patch: patchOfSize(testChars) },
      { filename: "modules/scheduling/test/session-rating.test.ts", status: "added", patch: patchOfSize(testChars) },
    ]);

    const includedPaths = included.map((f) => f.path);
    expect(includedPaths).toContain("modules/scheduling/application/ratings.ts");
    expect(includedPaths).toContain("modules/scheduling/domain/session-rating.ts");
    expect(includedPaths).toContain("drizzle/0006_session_ratings.sql");
    expect(skipped).toContain("contract/openapi.json");
    expect(skipped).toContain("drizzle/meta/0006_snapshot.json");
    // Only one 40% test file fits after the 30% source file; the second is skipped rather than any source file.
    expect(includedPaths).toContain("modules/scheduling/test/ratings.test.ts");
    expect(skipped).toContain("modules/scheduling/test/session-rating.test.ts");
  });

  it("fills tiers in order: source, schema, config, test, generated", () => {
    // Each file takes a quarter of the budget, so exactly four of the five fit.
    const quarter = patchOfSize(Math.floor(MAX_DIFF_CHARS / 4) - 20);
    const { included, skipped } = selectReviewableFiles([
      { filename: "a/openapi.json", status: "modified", patch: quarter },
      { filename: "b.test.ts", status: "modified", patch: quarter },
      { filename: "c/package.json", status: "modified", patch: quarter },
      { filename: "d/0001_init.sql", status: "modified", patch: quarter },
      { filename: "e/service.ts", status: "modified", patch: quarter },
    ]);

    expect(skipped).toEqual(["a/openapi.json"]);
    expect(included.map((f) => f.path)).toEqual(["b.test.ts", "c/package.json", "d/0001_init.sql", "e/service.ts"]);
  });

  it("returns included and skipped files in the original PR order, not ranking order", () => {
    const { included, skipped } = selectReviewableFiles([
      { filename: "z/openapi.json", status: "modified", patch: big },
      { filename: "b.test.ts", status: "modified", patch: small },
      { filename: "a/schema.sql", status: "modified", patch: small },
      { filename: "c/service.ts", status: "modified", patch: big },
      { filename: "d/util.ts", status: "modified", patch: small },
    ]);

    expect(included.map((f) => f.path)).toEqual(["b.test.ts", "a/schema.sql", "c/service.ts", "d/util.ts"]);
    expect(skipped).toEqual(["z/openapi.json"]);
  });

  it("keeps original order within a tier when spending the budget", () => {
    const { included, skipped } = selectReviewableFiles([
      { filename: "src/a.ts", status: "modified", patch: big },
      { filename: "src/b.ts", status: "modified", patch: big },
    ]);

    expect(included.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(skipped).toEqual(["src/b.ts"]);
  });
});
