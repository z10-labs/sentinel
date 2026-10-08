# Filling the sentinel-test secret

Stack: `sentinel-test` (us-east-1). Use your own stack name if it differs.

## 1. Set your values

Paste this into your terminal, replacing the four placeholders. Keep the quotes.

```bash
SECRET_ARN=$(aws cloudformation describe-stacks --region us-east-1 --stack-name sentinel-test \
  --query "Stacks[0].Outputs[?OutputKey=='SecretArn'].OutputValue" --output text)
APP_ID="123456"                                # GitHub App ID (numbers only)
PEM_PATH="$HOME/Downloads/your-app.2026-10-08.private-key.pem"   # path to the downloaded key file
WEBHOOK_SECRET="paste-the-openssl-rand-hex-32-value"            # same value you entered in the GitHub App
ANTHROPIC_KEY="sk-ant-..."                     # Anthropic API key
```

## 2. Write the secret

Run this exactly as written. Don't edit it; it reads the variables from step 1.
It first checks that the key file exists and isn't empty, so a wrong path can't write an empty key.

```bash
if [ ! -s "$PEM_PATH" ]; then
  echo "Key file not found or empty: $PEM_PATH"
else
  jq -n \
    --arg appId "$APP_ID" \
    --arg key "$(cat "$PEM_PATH")" \
    --arg webhook "$WEBHOOK_SECRET" \
    --arg anthropic "$ANTHROPIC_KEY" \
    '{githubAppId: $appId, githubPrivateKey: $key, githubWebhookSecret: $webhook, anthropicApiKey: $anthropic}' \
  | aws secretsmanager put-secret-value \
      --region us-east-1 \
      --secret-id "$SECRET_ARN" \
      --secret-string file:///dev/stdin
fi
```

On success it prints JSON containing `"ARN"`, `"Name"` and `"VersionId"`.

## 3. Check the format without printing secrets

```bash
aws secretsmanager get-secret-value --region us-east-1 --secret-id "$SECRET_ARN" \
  --query SecretString --output text \
| jq '{
    githubAppId,
    githubPrivateKey: (.githubPrivateKey | split("\n")[0]),
    githubWebhookSecretLength: (.githubWebhookSecret | length),
    anthropicApiKeyPrefix: (.anthropicApiKey | .[0:7])
  }'
```

Expected output:

```json
{
  "githubAppId": "123456",
  "githubPrivateKey": "-----BEGIN RSA PRIVATE KEY-----",
  "githubWebhookSecretLength": 64,
  "anthropicApiKeyPrefix": "sk-ant-"
}
```

If `githubPrivateKey` isn't a `-----BEGIN ... PRIVATE KEY-----` line, `PEM_PATH` pointed at the wrong file.

## 4. Clean up

```bash
unset APP_ID PEM_PATH WEBHOOK_SECRET ANTHROPIC_KEY
```

Then move the `.pem` somewhere safe or delete it. It's in `.gitignore`, but don't leave it in Downloads.

## 5. Test

1. In the GitHub App's **Advanced** tab, redeliver the `ping`. It should return **200**.
2. Install the app on a test repo and open a PR with a small deliberate bug.
3. Watch the worker:

```bash
sam logs -n ReviewWorkerFunction --stack-name sentinel-test --region us-east-1 --tail
```

Warm Lambda containers cache the secret once it loads successfully. An empty or incomplete secret is never
cached, so filling it in takes effect right away. But if you correct a *wrong* value (for example a webhook secret
that doesn't match the app), warm containers keep using the old one. Force fresh containers by changing an
environment variable on both functions or redeploying with a changed template.

## 6. Get emailed when reviews fail (optional)

The dead-letter-queue alarm publishes to an SNS topic (`AlarmTopicArn` output). To add an email subscription:

```bash
sam build && sam deploy --parameter-overrides AlarmEmail=you@example.com
```

Then open the "AWS Notification - Subscription Confirmation" email and click **Confirm subscription**.
Until you do, the subscription stays "PendingConfirmation" and no alerts are sent. Check it with:

```bash
aws sns list-subscriptions-by-topic --region us-east-1 --topic-arn "$(aws cloudformation describe-stacks \
  --region us-east-1 --stack-name sentinel-test \
  --query "Stacks[0].Outputs[?OutputKey=='AlarmTopicArn'].OutputValue" --output text)"
```

Later `sam deploy` runs without `--parameter-overrides` keep the stack's previous `AlarmEmail`. To stop the emails,
deploy with `--parameter-overrides AlarmEmail=""`. Changing the address creates a new subscription to confirm.
