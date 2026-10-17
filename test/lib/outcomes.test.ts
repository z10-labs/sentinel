import { describe, expect, it } from "vitest";
import {
  buildPostedCommentItem,
  buildReplyUpdate,
  classifyHumanReply,
  outcomeKey,
  resolveOutcome,
} from "../../src/lib/outcomes.js";

const PULL = { owner: "Dzithendo31", repo: "tutorspaces-api", pullNumber: 42 };

describe("classifyHumanReply", () => {
  it.each([
    "Addressed in 0aa9754: the job now requires event == push.",
    "addressed in abc",
    "Fixed in 1234567.",
    "Fixed.",
    "Done",
    "Good catch, fixed",
    "Applied the suggestion in 9f8e7d6",
  ])("treats %j as accepted", (body) => {
    expect(classifyHumanReply(body)).toBe("accepted");
  });

  it.each([
    "Leaving this as is. The scan runs every 10 minutes...",
    "Won't fix: out of scope",
    "Wontfix",
    "Not a bug: sessionLabels accepts null by design.",
    "This is intended.",
    "Intentional — see the design note.",
    "False positive, the query already filters these rows.",
  ])("treats %j as declined", (body) => {
    expect(classifyHumanReply(body)).toBe("declined");
  });

  it.each(["Why would this be null here?", "Can you explain the race?", ""])("treats %j as discussed", (body) => {
    expect(classifyHumanReply(body)).toBe("discussed");
  });

  it("ignores a leading quote of the bot's comment", () => {
    expect(classifyHumanReply("> 🟠 **Warning**: race here\n\nAddressed in abc123")).toBe("accepted");
  });
});

describe("resolveOutcome", () => {
  it("keeps the human's answer when it is clear", () => {
    expect(resolveOutcome("accepted", "retract")).toBe("accepted");
    expect(resolveOutcome("declined", "stand_by")).toBe("declined");
  });

  it("counts a retraction after discussion as declined", () => {
    expect(resolveOutcome("discussed", "retract")).toBe("declined");
  });

  it("stays discussed when the bot stands by or revises, or has no verdict yet", () => {
    expect(resolveOutcome("discussed", "stand_by")).toBe("discussed");
    expect(resolveOutcome("discussed", "revise")).toBe("discussed");
    expect(resolveOutcome("discussed", undefined)).toBe("discussed");
  });
});

describe("outcomeKey", () => {
  it("keys by PR and comment id", () => {
    expect(outcomeKey(PULL, 7)).toEqual({
      pk: { S: "Dzithendo31/tutorspaces-api#42" },
      sk: { S: "comment#7" },
    });
  });
});

describe("buildPostedCommentItem", () => {
  it("records an open comment with its severity and location", () => {
    const item = buildPostedCommentItem({
      pull: PULL,
      comment: { id: 7, path: "src/a.ts", line: 12, body: "🔴 **Critical**: secrets exposed" },
      headSha: "abc",
      model: "claude-sonnet-5-5",
      followUp: true,
      postedAt: "2026-10-17T18:00:00.000Z",
    });
    expect(item).toMatchObject({
      pk: { S: "Dzithendo31/tutorspaces-api#42" },
      sk: { S: "comment#7" },
      commentId: { N: "7" },
      path: { S: "src/a.ts" },
      line: { N: "12" },
      severity: { S: "critical" },
      headSha: { S: "abc" },
      model: { S: "claude-sonnet-5-5" },
      followUp: { BOOL: true },
      outcome: { S: "open" },
      postedAt: { S: "2026-10-17T18:00:00.000Z" },
    });
  });

  it("leaves out the line when GitHub has none and marks an unknown severity", () => {
    const item = buildPostedCommentItem({
      pull: PULL,
      comment: { id: 8, path: "src/a.ts", line: null, body: "no label" },
      headSha: "abc",
      model: "m",
      followUp: false,
      postedAt: "t",
    });
    expect(item.line).toBeUndefined();
    expect(item.severity).toEqual({ S: "unknown" });
  });

  it("clips a long comment body", () => {
    const item = buildPostedCommentItem({
      pull: PULL,
      comment: { id: 9, path: "a", line: 1, body: "x".repeat(10_000) },
      headSha: "abc",
      model: "m",
      followUp: false,
      postedAt: "t",
    });
    expect(item.body?.S?.length).toBeLessThanOrEqual(2000);
  });
});

describe("buildReplyUpdate", () => {
  it("sets the outcome, the reply and its class, and fills the location if the comment wasn't recorded", () => {
    const update = buildReplyUpdate({
      replyClass: "declined",
      replyBody: "Leaving this as is.",
      replyAuthor: "alice",
      root: { path: "src/a.ts", body: "🔵 **Suggestion**: batch it" },
      at: "t",
    });
    expect(update.UpdateExpression).toContain("#outcome = :outcome");
    expect(update.UpdateExpression).toContain("#path = if_not_exists(#path, :path)");
    expect(update.UpdateExpression).not.toContain("verdict");
    expect(update.ExpressionAttributeValues).toMatchObject({
      ":outcome": { S: "declined" },
      ":replyClass": { S: "declined" },
      ":lastReply": { S: "Leaving this as is." },
      ":lastReplyBy": { S: "alice" },
      ":severity": { S: "suggestion" },
    });
  });

  it("won't let a later unclear reply undo a retraction", () => {
    const update = buildReplyUpdate({ replyClass: "discussed", replyBody: "hm", replyAuthor: "a", root: { path: "a", body: "x" }, at: "t" });
    expect(update.ConditionExpression).toBe("attribute_not_exists(#verdict) OR #verdict <> :retract");
    expect(update.ExpressionAttributeValues[":retract"]).toEqual({ S: "retract" });
  });

  it("has no condition when the reply is clear or carries a verdict", () => {
    const clear = buildReplyUpdate({ replyClass: "accepted", replyBody: "Fixed", replyAuthor: "a", root: { path: "a", body: "x" }, at: "t" });
    const withVerdict = buildReplyUpdate({
      replyClass: "discussed",
      replyBody: "hm",
      replyAuthor: "a",
      root: { path: "a", body: "x" },
      verdict: "stand_by",
      at: "t",
    });
    expect(clear.ConditionExpression).toBeUndefined();
    expect(withVerdict.ConditionExpression).toBeUndefined();
  });

  it("records the bot's verdict and resolves the outcome with it", () => {
    const update = buildReplyUpdate({
      replyClass: "discussed",
      replyBody: "Why?",
      replyAuthor: "alice",
      root: { path: "a", body: "x" },
      verdict: "retract",
      at: "t",
    });
    expect(update.UpdateExpression).toContain("#verdict = :verdict");
    expect(update.ExpressionAttributeValues).toMatchObject({ ":verdict": { S: "retract" }, ":outcome": { S: "declined" } });
  });
});
