import { describe, expect, it } from "vitest";
import { parseModelResponse, parseReviewResult } from "../../src/lib/reviewer.js";

const validComment = { path: "a.ts", line: 3, severity: "critical", body: "Bug here" };

function textResponse(text: string, stopReason: string | null = "end_turn") {
  return { stop_reason: stopReason, content: [{ type: "text", text }] };
}

describe("parseReviewResult", () => {
  it("returns summary and valid comments", () => {
    const result = parseReviewResult({ summary: "Looks fine", comments: [validComment] });
    expect(result).toEqual({ summary: "Looks fine", comments: [validComment] });
  });

  it("accepts an empty comments array and an empty summary string", () => {
    expect(parseReviewResult({ summary: "", comments: [] })).toEqual({ summary: "", comments: [] });
  });

  it.each([undefined, null, "text", 42, []])("throws when the input is %j", (input) => {
    expect(() => parseReviewResult(input)).toThrow("missing a summary");
  });

  it("throws when summary is missing or not a string", () => {
    expect(() => parseReviewResult({ comments: [] })).toThrow("missing a summary");
    expect(() => parseReviewResult({ summary: 5, comments: [] })).toThrow("missing a summary");
  });

  it("treats missing or non-array comments as no comments", () => {
    expect(parseReviewResult({ summary: "s" }).comments).toEqual([]);
    expect(parseReviewResult({ summary: "s", comments: "nope" }).comments).toEqual([]);
    expect(parseReviewResult({ summary: "s", comments: { 0: validComment } }).comments).toEqual([]);
  });

  it("drops malformed comments but keeps valid ones", () => {
    const result = parseReviewResult({
      summary: "s",
      comments: [
        validComment,
        null,
        "str",
        { ...validComment, path: undefined },
        { ...validComment, line: "3" },
        { ...validComment, body: 7 },
        { ...validComment, severity: "blocker" },
        { ...validComment, severity: undefined },
      ],
    });
    expect(result.comments).toEqual([validComment]);
  });

  it("accepts every defined severity", () => {
    const comments = ["critical", "warning", "suggestion"].map((severity) => ({ ...validComment, severity }));
    expect(parseReviewResult({ summary: "s", comments }).comments).toHaveLength(3);
  });
});

describe("parseModelResponse", () => {
  it("parses a JSON review from a text block", () => {
    const body = JSON.stringify({ summary: "ok", comments: [validComment] });
    expect(parseModelResponse(textResponse(body))).toEqual({ summary: "ok", comments: [validComment] });
  });

  it("ignores non-text blocks (such as thinking) and joins text blocks", () => {
    const body = JSON.stringify({ summary: "ok", comments: [] });
    const response = {
      stop_reason: "end_turn",
      content: [
        { type: "thinking" },
        { type: "text", text: body.slice(0, 10) },
        { type: "text", text: body.slice(10) },
      ],
    };
    expect(parseModelResponse(response).summary).toBe("ok");
  });

  it.each(["max_tokens", "refusal", "tool_use", "pause_turn", null])(
    "throws when stop_reason is %j",
    (stopReason) => {
      const body = JSON.stringify({ summary: "ok", comments: [] });
      expect(() => parseModelResponse(textResponse(body, stopReason))).toThrow("did not finish the review");
    },
  );

  it("checks stop_reason before parsing, so truncated JSON reports the stop reason", () => {
    expect(() => parseModelResponse(textResponse('{"summary": "cut', "max_tokens"))).toThrow(/max_tokens/);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseModelResponse(textResponse("{not json"))).toThrow(SyntaxError);
  });

  it("throws on empty content", () => {
    expect(() => parseModelResponse({ stop_reason: "end_turn", content: [] })).toThrow(SyntaxError);
  });

  it("throws when the JSON lacks a summary", () => {
    expect(() => parseModelResponse(textResponse(JSON.stringify({ comments: [] })))).toThrow("missing a summary");
  });

  it("throws when the JSON is null", () => {
    expect(() => parseModelResponse(textResponse("null"))).toThrow("missing a summary");
  });
});
