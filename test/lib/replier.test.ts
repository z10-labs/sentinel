import { describe, expect, it } from "vitest";
import {
  buildReplyPrompt,
  formatReplyBody,
  parseReplyResponse,
  parseReplyResult,
  type ReplyInput,
} from "../../src/lib/replier.js";

const input: ReplyInput = {
  prTitle: "Add retries",
  path: "src/a.ts",
  line: 12,
  diffHunk: "@@ -10,3 +10,4 @@\n+  retry();",
  currentExcerpt: "   12   retry();",
  thread: [
    { author: "sentinel-by-z10[bot]", isBot: true, body: "🟠 **Warning**: unbounded retry\n<!-- review-bot:abc -->" },
    { author: "alice", isBot: false, body: "retry() is capped at 3 inside the helper" },
  ],
};

describe("buildReplyPrompt", () => {
  it("includes location, hunk, current code and the thread with roles", () => {
    const prompt = buildReplyPrompt(input);
    expect(prompt).toContain("`src/a.ts:12`");
    expect(prompt).toContain("+  retry();");
    expect(prompt).toContain("   12   retry();");
    expect(prompt).toContain('<comment author="sentinel-by-z10[bot]" role="you">');
    expect(prompt).toContain('<comment author="alice" role="human">\nretry() is capped at 3 inside the helper\n</comment>');
  });

  it("strips hidden markers from comment bodies", () => {
    expect(buildReplyPrompt(input)).not.toContain("<!--");
  });

  it("says when the file is gone at head", () => {
    const prompt = buildReplyPrompt({ ...input, currentExcerpt: undefined, line: undefined });
    expect(prompt).toContain("no longer exists");
    expect(prompt).toContain("(`src/a.ts`)");
  });
});

describe("parseReplyResult", () => {
  it.each(["stand_by", "revise", "retract"])("accepts verdict %s and trims the reply", (verdict) => {
    expect(parseReplyResult({ verdict, reply: "  You're right.  " })).toEqual({ verdict, reply: "You're right." });
  });

  it.each([undefined, null, {}, { verdict: "maybe", reply: "x" }])("rejects a bad verdict in %j", (value) => {
    expect(() => parseReplyResult(value)).toThrow("no valid verdict");
  });

  it("rejects an empty reply", () => {
    expect(() => parseReplyResult({ verdict: "retract", reply: "  " })).toThrow("empty");
    expect(() => parseReplyResult({ verdict: "retract" })).toThrow("empty");
  });
});

describe("parseReplyResponse", () => {
  it("parses a structured reply", () => {
    const response = {
      stop_reason: "end_turn",
      content: [{ type: "text", text: JSON.stringify({ verdict: "retract", reply: "Fair, it's capped." }) }],
    };
    expect(parseReplyResponse(response)).toEqual({ kind: "ok", value: { verdict: "retract", reply: "Fair, it's capped." } });
  });

  it("maps a refusal to a permanent outcome", () => {
    const response = { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] };
    expect(parseReplyResponse(response)).toMatchObject({ kind: "unreviewable", reason: "refusal", refusalCategory: "cyber" });
  });

  it("throws on unexpected stop reasons", () => {
    expect(() => parseReplyResponse({ stop_reason: "tool_use", content: [] })).toThrow("did not finish the reply");
  });
});

describe("formatReplyBody", () => {
  it("labels the verdict and appends the marker", () => {
    expect(formatReplyBody({ verdict: "stand_by", reply: "Still unbounded." }, "<!-- m -->")).toBe(
      "📌 **Standing by this**: Still unbounded.\n\n<!-- m -->",
    );
  });
});
