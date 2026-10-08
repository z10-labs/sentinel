import { createHmac, timingSafeEqual } from "node:crypto";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { loadSecrets, requireEnv } from "./lib/config.js";
import { logger } from "./lib/logger.js";
import type { ReviewJob } from "./lib/types.js";

const REVIEWABLE_ACTIONS: ReadonlySet<string> = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const sqs = new SQSClient({});

/** The parts of GitHub's pull_request webhook payload this bot uses. */
interface PullRequestPayload {
  action: string;
  installation?: { id: number };
  repository: { name: string; owner: { login: string } };
  pull_request: { number: number; draft: boolean; head: { sha: string } };
}

function respond(statusCode: number, message: string): LambdaFunctionURLResult {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) };
}

function readRawBody(event: LambdaFunctionURLEvent): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

/** Confirms the request really came from GitHub, using the shared webhook secret. */
export function isValidSignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  const received = Buffer.from(signatureHeader);
  const computed = Buffer.from(expected);
  return received.length === computed.length && timingSafeEqual(received, computed);
}

function toReviewJob(payload: PullRequestPayload, deliveryId: string): ReviewJob | undefined {
  if (!payload.installation) return undefined;
  return {
    deliveryId,
    installationId: payload.installation.id,
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    pullNumber: payload.pull_request.number,
    headSha: payload.pull_request.head.sha,
  };
}

/**
 * Receives GitHub webhooks. It only validates, filters and enqueues, so it answers well within
 * GitHub's 10-second delivery timeout. The actual review runs in the worker.
 */
export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const deliveryId = event.headers["x-github-delivery"] ?? "unknown";
  const eventName = event.headers["x-github-event"];
  const rawBody = readRawBody(event);

  const { githubWebhookSecret } = await loadSecrets();
  if (!isValidSignature(rawBody, event.headers["x-hub-signature-256"], githubWebhookSecret)) {
    logger.warn("Rejected webhook with invalid signature", { deliveryId });
    return respond(401, "invalid signature");
  }

  if (eventName === "ping") return respond(200, "pong");
  if (eventName !== "pull_request") return respond(202, `ignored event ${eventName}`);

  let payload: PullRequestPayload;
  try {
    payload = JSON.parse(rawBody) as PullRequestPayload;
  } catch {
    return respond(400, "invalid JSON");
  }

  if (!REVIEWABLE_ACTIONS.has(payload.action)) return respond(202, `ignored action ${payload.action}`);
  if (payload.pull_request.draft) return respond(202, "ignored draft PR");

  const job = toReviewJob(payload, deliveryId);
  if (!job) return respond(400, "payload has no installation id");

  await sqs.send(new SendMessageCommand({ QueueUrl: requireEnv("QUEUE_URL"), MessageBody: JSON.stringify(job) }));
  logger.info("Queued review", { ...job });
  return respond(202, "queued");
}
