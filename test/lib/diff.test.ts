import { describe, expect, it } from "vitest";
import { analyzePatch, isReviewablePath, MAX_DIFF_CHARS, selectReviewableFiles } from "../../src/lib/diff.js";

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
