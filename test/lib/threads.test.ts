import { describe, expect, it } from "vitest";
import {
  decideReply,
  excerptAround,
  isRetracted,
  MAX_BOT_REPLIES_PER_THREAD,
  replyMarker,
  retractedBody,
  selectThread,
  type ThreadComment,
} from "../../src/lib/threads.js";

const BOT = "sentinel-by-z10[bot]";

function comment(id: number, login: string, extra: Partial<ThreadComment> = {}): ThreadComment {
  return {
    id,
    user: { login, type: login === BOT ? "Bot" : "User" },
    body: `body-${id}`,
    created_at: `2026-10-08T10:00:${String(id).padStart(2, "0")}Z`,
    path: "src/a.ts",
    line: 10,
    original_line: 10,
    diff_hunk: "@@ -1 +1 @@",
    ...extra,
  };
}

describe("selectThread", () => {
  const root = comment(1, BOT);
  const reply = comment(3, "alice", { in_reply_to_id: 1 });
  const botReply = comment(4, BOT, { in_reply_to_id: 1 });
  const otherThread = comment(2, BOT);
  const otherReply = comment(5, "bob", { in_reply_to_id: 2 });
  const all = [botReply, otherReply, reply, otherThread, root];

  it("returns the thread oldest first, starting at the root", () => {
    expect(selectThread(all, 1).map((c) => c.id)).toEqual([1, 3, 4]);
  });

  it("finds the root when given a reply's id", () => {
    expect(selectThread(all, 3).map((c) => c.id)).toEqual([1, 3, 4]);
  });

  it("returns an empty thread when the comment is gone", () => {
    expect(selectThread(all, 99)).toEqual([]);
  });

  it("does not reorder the input array", () => {
    const input = [...all];
    selectThread(input, 1);
    expect(input).toEqual(all);
  });
});

describe("decideReply", () => {
  const root = comment(1, BOT);
  const human = comment(2, "alice", { in_reply_to_id: 1 });

  it("replies to a human in a thread the bot started", () => {
    expect(decideReply({ thread: [root, human], triggerCommentId: 2, botLogin: BOT })).toEqual({ action: "reply" });
  });

  it("skips threads started by someone else", () => {
    const thread = [comment(1, "carol"), human];
    expect(decideReply({ thread, triggerCommentId: 2, botLogin: BOT })).toMatchObject({ action: "skip" });
  });

  it("skips when the trigger comment is missing", () => {
    expect(decideReply({ thread: [root], triggerCommentId: 2, botLogin: BOT })).toMatchObject({ action: "skip" });
    expect(decideReply({ thread: [], triggerCommentId: 2, botLogin: BOT })).toMatchObject({ action: "skip" });
  });

  it("skips the bot's own replies", () => {
    const own = comment(2, BOT, { in_reply_to_id: 1 });
    expect(decideReply({ thread: [root, own], triggerCommentId: 2, botLogin: BOT })).toMatchObject({ action: "skip" });
  });

  it("skips a reply it has already answered (SQS redelivery)", () => {
    const answered = comment(3, BOT, { in_reply_to_id: 1, body: `ok\n\n${replyMarker(2)}` });
    const decision = decideReply({ thread: [root, human, answered], triggerCommentId: 2, botLogin: BOT });
    expect(decision).toEqual({ action: "skip", reason: "already answered this reply" });
  });

  it("answers a later reply even after answering an earlier one", () => {
    const answered = comment(3, BOT, { in_reply_to_id: 1, body: replyMarker(2) });
    const second = comment(4, "alice", { in_reply_to_id: 1 });
    const decision = decideReply({ thread: [root, human, answered, second], triggerCommentId: 4, botLogin: BOT });
    expect(decision).toEqual({ action: "reply" });
  });

  it("stops after the per-thread reply limit", () => {
    const botReplies = Array.from({ length: MAX_BOT_REPLIES_PER_THREAD }, (_, i) =>
      comment(10 + i, BOT, { in_reply_to_id: 1, body: replyMarker(100 + i) }),
    );
    const latest = comment(50, "alice", { in_reply_to_id: 1 });
    const decision = decideReply({ thread: [root, ...botReplies, latest], triggerCommentId: 50, botLogin: BOT });
    expect(decision).toEqual({ action: "skip", reason: "reply limit for this thread reached" });
  });
});

describe("retractedBody", () => {
  it("prepends the banner once", () => {
    const once = retractedBody("🟠 **Warning**: bug");
    expect(isRetracted(once)).toBe(true);
    expect(once.endsWith("🟠 **Warning**: bug")).toBe(true);
    expect(retractedBody(once)).toBe(once);
  });
});

describe("excerptAround", () => {
  const content = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

  it("numbers lines and centres on the target", () => {
    const excerpt = excerptAround(content, 100) ?? "";
    const lines = excerpt.split("\n");
    expect(lines[0]).toBe("   60 line 60");
    expect(lines.at(-1)).toBe("  140 line 140");
  });

  it("clamps at the start and end of the file", () => {
    expect(excerptAround(content, 1)?.split("\n")[0]).toBe("    1 line 1");
    expect(excerptAround(content, 200)?.split("\n").at(-1)).toBe("  200 line 200");
  });

  it("returns undefined for a line outside the file", () => {
    expect(excerptAround(content, 0)).toBeUndefined();
    expect(excerptAround(content, 201)).toBeUndefined();
  });
});
