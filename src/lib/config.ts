import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export interface BotSecrets {
  readonly githubAppId: string;
  readonly githubPrivateKey: string;
  readonly githubWebhookSecret: string;
  readonly anthropicApiKey: string;
}

const REQUIRED_SECRET_KEYS: readonly (keyof BotSecrets)[] = [
  "githubAppId",
  "githubPrivateKey",
  "githubWebhookSecret",
  "anthropicApiKey",
];

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

// Cached per Lambda container so warm invocations skip the Secrets Manager call.
let cachedSecrets: Promise<BotSecrets> | undefined;

export function loadSecrets(): Promise<BotSecrets> {
  if (!cachedSecrets) {
    cachedSecrets = fetchSecrets().catch((error: unknown) => {
      cachedSecrets = undefined; // don't cache a failure; retry on the next invocation
      throw error;
    });
  }
  return cachedSecrets;
}

async function fetchSecrets(): Promise<BotSecrets> {
  const client = new SecretsManagerClient({});
  const response = await client.send(new GetSecretValueCommand({ SecretId: requireEnv("SECRET_ARN") }));
  if (!response.SecretString) throw new Error("Secret has no string value");

  const parsed = JSON.parse(response.SecretString) as Record<string, unknown>;
  const missing = REQUIRED_SECRET_KEYS.filter((key) => typeof parsed[key] !== "string" || parsed[key] === "");
  if (missing.length > 0) throw new Error(`Secret is missing keys: ${missing.join(", ")}`);

  return parsed as unknown as BotSecrets;
}
