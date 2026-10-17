import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isValidSignature, type ReviewCommentPayload, toReplyJob } from "../src/webhook.js";

const SECRET = "s3cret";
const BODY = JSON.stringify({ action: "opened" });

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("isValidSignature", () => {
  it("accepts a correct signature", () => {
    expect(isValidSignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  it("accepts a correct signature over a non-ASCII body", () => {
    const body = JSON.stringify({ title: "café \u{1F680}" });
    expect(isValidSignature(body, sign(body, SECRET), SECRET)).toBe(true);
  });

  it("accepts a correct signature over an empty body", () => {
    expect(isValidSignature("", sign("", SECRET), SECRET)).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(isValidSignature(BODY, sign(BODY, "other"), SECRET)).toBe(false);
  });

  it("rejects when the body was tampered with", () => {
    expect(isValidSignature(`${BODY} `, sign(BODY, SECRET), SECRET)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isValidSignature(BODY, undefined, SECRET)).toBe(false);
  });

  it("rejects an empty header", () => {
    expect(isValidSignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects a header without the sha256= prefix", () => {
    const bare = sign(BODY, SECRET).slice("sha256=".length);
    expect(isValidSignature(BODY, bare, SECRET)).toBe(false);
  });

  it("rejects the legacy sha1= scheme", () => {
    expect(isValidSignature(BODY, "sha1=abcdef", SECRET)).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    const truncated = sign(BODY, SECRET).slice(0, -2);
    expect(isValidSignature(BODY, truncated, SECRET)).toBe(false);
    expect(isValidSignature(BODY, `${sign(BODY, SECRET)}00`, SECRET)).toBe(false);
    expect(isValidSignature(BODY, "sha256=", SECRET)).toBe(false);
  });

  it("rejects same-length garbage", () => {
    const garbage = `sha256=${"0".repeat(64)}`;
    expect(isValidSignature(BODY, garbage, SECRET)).toBe(false);
  });

  it("is case sensitive on the hex digest", () => {
    const upper = `sha256=${sign(BODY, SECRET).slice("sha256=".length).toUpperCase()}`;
    expect(isValidSignature(BODY, upper, SECRET)).toBe(false);
  });
});

describe("toReplyJob", () => {
  const base: ReviewCommentPayload = {
    action: "created",
    installation: { id: 7 },
    repository: { name: "payme", owner: { login: "Dzithendo31" } },
    pull_request: { number: 12, user: { login: "author" } },
    comment: { id: 200, in_reply_to_id: 100, author_association: "MEMBER", user: { login: "alice", type: "User" } },
  };

  function withComment(overrides: Partial<ReviewCommentPayload["comment"]>): ReviewCommentPayload {
    return { ...base, comment: { ...base.comment, ...overrides } };
  }

  it("builds a reply job for a trusted human reply", () => {
    expect(toReplyJob(base, "d1")).toEqual({
      job: {
        kind: "reply",
        deliveryId: "d1",
        installationId: 7,
        owner: "Dzithendo31",
        repo: "payme",
        pullNumber: 12,
        commentId: 200,
        inReplyToId: 100,
      },
    });
  });

  it("accepts the PR author even without a trusted association", () => {
    const payload = withComment({ author_association: "CONTRIBUTOR", user: { login: "author", type: "User" } });
    expect(toReplyJob(payload, "d1")).toHaveProperty("job");
  });

  it.each(["NONE", "FIRST_TIME_CONTRIBUTOR", "CONTRIBUTOR"])("ignores other users with association %s", (association) => {
    expect(toReplyJob(withComment({ author_association: association }), "d1")).toHaveProperty("ignored");
  });

  it("ignores top-level comments, edits and deletions", () => {
    expect(toReplyJob(withComment({ in_reply_to_id: undefined }), "d1")).toEqual({ ignored: "not a reply" });
    expect(toReplyJob({ ...base, action: "edited" }, "d1")).toEqual({ ignored: "action edited" });
    expect(toReplyJob({ ...base, action: "deleted" }, "d1")).toEqual({ ignored: "action deleted" });
  });

  it("ignores bots, including itself", () => {
    const bot = withComment({ author_association: "NONE", user: { login: "sentinel-by-z10[bot]", type: "Bot" } });
    expect(toReplyJob(bot, "d1")).toEqual({ ignored: "author is a bot" });
    expect(toReplyJob(withComment({ user: null }), "d1")).toEqual({ ignored: "author is a bot" });
  });

  it("ignores payloads without an installation", () => {
    expect(toReplyJob({ ...base, installation: undefined }, "d1")).toEqual({ ignored: "no installation id" });
  });
});
