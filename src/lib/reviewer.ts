import Anthropic from "@anthropic-ai/sdk";
import { loadSecrets } from "./config.js";
import type { DiffFile, ReviewComment, ReviewResult, Severity } from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-5-5";
// Thinking is always on for current models and shares this budget with the JSON answer.
const MAX_OUTPUT_TOKENS = 16_000;
// Leaves headroom under the worker's 300s Lambda timeout, so a slow call fails cleanly and is retried.
const REQUEST_TIMEOUT_MS = 240_000;
const MAX_DESCRIPTION_CHARS = 4000;
const SEVERITIES: readonly Severity[] = ["critical", "warning", "suggestion"];

const SYSTEM_PROMPT = `You are a senior engineer reviewing a pull request.

Focus on issues that matter: bugs, incorrect logic, unhandled errors and edge cases, security problems
(injection, secrets, auth checks), race conditions, resource leaks, and clear performance problems.
Skip formatting and style nits that a linter would catch.

Rules:
- Only comment on lines that have a line number in the diff. Use that exact number and the file path shown.
- Each comment should say what is wrong, why it matters, and how to fix it. Keep it short.
- Use "critical" for bugs or security issues, "warning" for likely problems, "suggestion" for worthwhile improvements.
- If the change looks good, say so in the summary and return no comments. Do not invent problems.
- Respond with the review as JSON matching the required schema.`;

// Structured outputs constrain the response to this schema. Forced tool_choice is rejected by current models.
const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "2-4 sentences: what the PR does and your overall assessment.",
    },
    comments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path exactly as shown in the diff header." },
          line: { type: "integer", description: "Line number from the left margin of the diff." },
          severity: { type: "string", enum: [...SEVERITIES] },
          body: { type: "string", description: "The review comment, in Markdown." },
        },
        required: ["path", "line", "severity", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "comments"],
  additionalProperties: false,
};

export interface ReviewInput {
  readonly title: string;
  readonly description: string;
  readonly files: readonly DiffFile[];
  readonly skippedFiles: readonly string[];
}

let cachedClient: Anthropic | undefined;

async function getClient(): Promise<Anthropic> {
  if (!cachedClient) {
    const { anthropicApiKey } = await loadSecrets();
    cachedClient = new Anthropic({ apiKey: anthropicApiKey, maxRetries: 3, timeout: REQUEST_TIMEOUT_MS });
  }
  return cachedClient;
}

function buildPrompt(input: ReviewInput): string {
  const fileSections = input.files.map(
    (file) => `### ${file.path}\n\`\`\`diff\n${file.annotatedPatch}\n\`\`\``,
  );
  const skippedNote =
    input.skippedFiles.length > 0
      ? `\n\n(${input.skippedFiles.length} more files were left out to keep the diff small.)`
      : "";

  return [
    `# Pull request: ${input.title}`,
    input.description ? `## Description\n${input.description.slice(0, MAX_DESCRIPTION_CHARS)}` : "",
    "## Diff",
    "Each added or unchanged line is prefixed with its line number in the new file. Removed lines have no number.",
    ...fileSections,
  ]
    .filter(Boolean)
    .join("\n\n")
    .concat(skippedNote);
}

function isReviewComment(value: unknown): value is ReviewComment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" &&
    typeof candidate.line === "number" &&
    typeof candidate.body === "string" &&
    SEVERITIES.includes(candidate.severity as Severity)
  );
}

function parseReviewResult(input: unknown): ReviewResult {
  const candidate = (input ?? {}) as Record<string, unknown>;
  if (typeof candidate.summary !== "string") throw new Error("Model response is missing a summary");
  const comments = Array.isArray(candidate.comments) ? candidate.comments.filter(isReviewComment) : [];
  return { summary: candidate.summary, comments };
}

/** Sends the diff to Claude and returns a structured review. */
export async function requestReview(input: ReviewInput): Promise<ReviewResult> {
  const client = await getClient();
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: REVIEW_SCHEMA } },
    messages: [{ role: "user", content: buildPrompt(input) }],
  });

  if (response.stop_reason !== "end_turn") {
    throw new Error(`Model did not finish the review (stop_reason: ${response.stop_reason})`);
  }
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return parseReviewResult(JSON.parse(text));
}
