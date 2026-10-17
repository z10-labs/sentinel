import {
  type AttributeValue,
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { type PostedComment, severityFromBody } from "./github.js";
import { logger } from "./logger.js";
import type { ReplyVerdict } from "./replier.js";
import type { PullRef } from "./types.js";

/** How a human answered one of the bot's comments, read from their reply. */
export type ReplyClass = "accepted" | "declined" | "discussed";
/** A comment's outcome so far. "open" means no human has replied in its thread. */
export type Outcome = "open" | ReplyClass;

type Item = Record<string, AttributeValue>;

const MAX_STORED_BODY_CHARS = 2000;
const MAX_STORED_REPLY_CHARS = 1000;

// Checked against the reply with any leading quote removed. Declines first: "not fixed" isn't a fix.
const DECLINED_PATTERNS: readonly RegExp[] = [
  /^leaving (this|it) as is/i,
  /^won'?t ?fix/i,
  /^not (a|an) (bug|issue|problem)/i,
  /^(this is )?(intended|intentional|by design)/i,
  /^false positive/i,
  /^(no|nope)[,.:]/i,
];
const ACCEPTED_PATTERNS: readonly RegExp[] = [
  /^addressed in\b/i,
  /^fixed\b/i,
  /^done\b/i,
  /^applied\b/i,
  /^good catch/i,
];

/** Drops Markdown quote lines (people often quote the comment they answer) and surrounding space. */
function stripQuotes(body: string): string {
  return body
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .trim();
}

/** Reads a human reply as accepted, declined or neither. Conservative: anything unclear is "discussed". */
export function classifyHumanReply(body: string): ReplyClass {
  const text = stripQuotes(body);
  if (DECLINED_PATTERNS.some((pattern) => pattern.test(text))) return "declined";
  if (ACCEPTED_PATTERNS.some((pattern) => pattern.test(text))) return "accepted";
  return "discussed";
}

/** Combines the human's reply with the bot's verdict. A clear human answer wins; a retraction concedes. */
export function resolveOutcome(replyClass: ReplyClass, verdict: ReplyVerdict | undefined): ReplyClass {
  if (replyClass !== "discussed") return replyClass;
  return verdict === "retract" ? "declined" : "discussed";
}

export function outcomeKey(pull: PullRef, commentId: number): { pk: AttributeValue; sk: AttributeValue } {
  return { pk: { S: `${pull.owner}/${pull.repo}#${pull.pullNumber}` }, sk: { S: `comment#${commentId}` } };
}

const clip = (text: string, max: number): string => text.slice(0, max);

export function buildPostedCommentItem(params: {
  pull: PullRef;
  comment: PostedComment;
  headSha: string;
  model: string;
  followUp: boolean;
  postedAt: string;
}): Item {
  const { pull, comment } = params;
  const line = comment.line ?? undefined;
  return {
    ...outcomeKey(pull, comment.id),
    repo: { S: `${pull.owner}/${pull.repo}` },
    pullNumber: { N: String(pull.pullNumber) },
    commentId: { N: String(comment.id) },
    path: { S: comment.path },
    ...(line === undefined ? {} : { line: { N: String(line) } }),
    severity: { S: severityFromBody(comment.body) ?? "unknown" },
    body: { S: clip(comment.body, MAX_STORED_BODY_CHARS) },
    headSha: { S: params.headSha },
    model: { S: params.model },
    followUp: { BOOL: params.followUp },
    outcome: { S: "open" },
    postedAt: { S: params.postedAt },
  };
}

/**
 * Update for a human reply. Upserts, so comments posted before tracking existed still get a record;
 * `if_not_exists` fills their location without overwriting what the review recorded.
 */
export function buildReplyUpdate(params: {
  replyClass: ReplyClass;
  replyBody: string;
  replyAuthor: string;
  root: { readonly path: string; readonly body: string };
  verdict?: ReplyVerdict;
  at: string;
}): {
  UpdateExpression: string;
  ConditionExpression?: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Item;
} {
  // An unclear reply with no verdict yet must not turn a retracted ("declined") comment back into "discussed".
  const guardRetraction = params.replyClass === "discussed" && params.verdict === undefined;
  const verdictParts = params.verdict ? ["#verdict = :verdict"] : [];
  const assignments = [
    "#outcome = :outcome",
    "#replyClass = :replyClass",
    "#lastReply = :lastReply",
    "#lastReplyBy = :lastReplyBy",
    "#repliedAt = :at",
    "#path = if_not_exists(#path, :path)",
    "#severity = if_not_exists(#severity, :severity)",
    "#body = if_not_exists(#body, :body)",
    ...verdictParts,
  ];
  const names = ["outcome", "replyClass", "lastReply", "lastReplyBy", "repliedAt", "path", "severity", "body"];

  return {
    UpdateExpression: `SET ${assignments.join(", ")}`,
    ...(guardRetraction ? { ConditionExpression: "attribute_not_exists(#verdict) OR #verdict <> :retract" } : {}),
    ExpressionAttributeNames: Object.fromEntries(
      [...names, ...(params.verdict || guardRetraction ? ["verdict"] : [])].map((name) => [`#${name}`, name]),
    ),
    ExpressionAttributeValues: {
      ":outcome": { S: resolveOutcome(params.replyClass, params.verdict) },
      ":replyClass": { S: params.replyClass },
      ":lastReply": { S: clip(params.replyBody, MAX_STORED_REPLY_CHARS) },
      ":lastReplyBy": { S: params.replyAuthor },
      ":at": { S: params.at },
      ":path": { S: params.root.path },
      ":severity": { S: severityFromBody(params.root.body) ?? "unknown" },
      ":body": { S: clip(params.root.body, MAX_STORED_BODY_CHARS) },
      ...(params.verdict ? { ":verdict": { S: params.verdict } } : {}),
      ...(guardRetraction ? { ":retract": { S: "retract" } } : {}),
    },
  };
}

let cachedClient: DynamoDBClient | undefined;

/** The table name, or undefined when tracking is off (no OUTCOMES_TABLE, e.g. local runs and tests). */
function outcomesTable(): string | undefined {
  return process.env.OUTCOMES_TABLE || undefined;
}

function client(): DynamoDBClient {
  cachedClient ??= new DynamoDBClient({});
  return cachedClient;
}

/**
 * Records the inline comments a review posted, each as "open". Tracking is best-effort: a failure is
 * logged and never fails the review, which is already on the PR. Existing records are kept, so a
 * redelivered job can't reset an outcome.
 */
export async function recordPostedComments(
  pull: PullRef,
  comments: readonly PostedComment[],
  meta: { headSha: string; model: string; followUp: boolean },
): Promise<void> {
  const table = outcomesTable();
  if (!table || comments.length === 0) return;
  const postedAt = new Date().toISOString();

  const results = await Promise.allSettled(
    comments.map((comment) =>
      client().send(
        new PutItemCommand({
          TableName: table,
          Item: buildPostedCommentItem({ pull, comment, postedAt, ...meta }),
          ConditionExpression: "attribute_not_exists(sk)",
        }),
      ),
    ),
  );
  const failures = results.filter(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected" && !(result.reason instanceof ConditionalCheckFailedException),
  );
  if (failures.length > 0) {
    logger.error("Could not record posted comments", failures[0]?.reason, {
      pr: pull.pullNumber,
      failed: failures.length,
      total: comments.length,
    });
  }
}

/** Records a human's reply to one of the bot's comments, and the bot's verdict when there is one. Best-effort. */
export async function recordReply(
  pull: PullRef,
  rootCommentId: number,
  params: Omit<Parameters<typeof buildReplyUpdate>[0], "at">,
): Promise<void> {
  const table = outcomesTable();
  if (!table) return;
  try {
    await client().send(
      new UpdateItemCommand({
        TableName: table,
        Key: outcomeKey(pull, rootCommentId),
        ...buildReplyUpdate({ ...params, at: new Date().toISOString() }),
      }),
    );
  } catch (error: unknown) {
    // A failed condition means the comment was already retracted; keeping that outcome is the point.
    if (error instanceof ConditionalCheckFailedException) return;
    logger.error("Could not record reply outcome", error, { pr: pull.pullNumber, rootCommentId });
  }
}
