# Shopify Webhook Handler — Cloudflare Worker

A serverless middleware service that receives Shopify "order created" webhooks, verifies their authenticity, strips sensitive customer data, and relays the cleaned payload back to the Shopify store via the Admin API.

## Overview

This Worker acts as a secure relay between Shopify and a hypothetical third-party destination. It receives a Shopify `orders/create` webhook over HTTPS, validates the request using HMAC-SHA256 to confirm it genuinely originated from Shopify, sanitizes the order payload by redacting personally identifiable information (PII), and forwards the cleaned payload to a simulated third-party destination — in this case, saving it back to the Shopify store as an order metafield via the GraphQL Admin API.

This is a proof-of-concept implementation, not a production-grade system. See the "What I'd Do Differently in Production" section for the gaps.

## Architecture

The service is built as a single Cloudflare Worker. When Shopify sends an `orders/create` webhook via HTTPS POST, the Worker performs four steps in sequence: it verifies the HMAC signature, parses the JSON payload, sanitizes sensitive fields, and relays the cleaned data onward. The "onward" destination in this implementation is the Shopify Admin API itself, where the sanitized payload is stored as an order metafield using the `metafieldsSet` GraphQL mutation.

Cloudflare Workers was chosen for several reasons. It has zero cold-start latency because it runs on V8 isolates rather than containers. It provides native Web Crypto and `fetch` APIs without needing polyfills. It offers a generous free tier of 100,000 requests per day without requiring a credit card. And deployment is simple via the Wrangler CLI.

## Setup Instructions

### Prerequisites

You will need Node.js v18 or later, a Cloudflare account (the free tier is sufficient), and a Shopify store (a development store works fine) with a Shared Secret found under Settings → Notifications → Webhooks, plus an Admin API Access Token from a custom app with `write_orders` scope.

### Step 1: Clone and install

Clone the repository and run `npm install` to install dependencies.

### Step 2: Configure the project

Ensure your `wrangler.toml` contains the following:

```
name = "shopify-webhook-handler"
main = "src/index.js"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
```

The `nodejs_compat` flag is required to use the `crypto` and `buffer` Node.js modules inside the Worker.

### Step 3: Set secrets

Run each of the following commands and paste the corresponding value when prompted:

```
npx wrangler secret put SHOPIFY_SHARED_SECRET
npx wrangler secret put SHOPIFY_ACCESS_TOKEN
npx wrangler secret put SHOPIFY_SHOP_DOMAIN
```

For local development, create a `.dev.vars` file in the project root and add it to `.gitignore`:

```
SHOPIFY_SHARED_SECRET=your_shared_secret_here
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxx
SHOPIFY_SHOP_DOMAIN=your-store.myshopify.com
```

### Step 4: Deploy

Run `npx wrangler deploy`. Wrangler will output your Worker's public URL, for example `https://shopify-webhook-handler.your-subdomain.workers.dev`.

### Step 5: Register the webhook in Shopify

In your Shopify admin, go to Settings → Notifications → Webhooks and create a webhook with the event "Order creation", format JSON, and the URL of your deployed Worker. Use API version 2024-10 or the latest stable version. Shopify will immediately send a test request. A `200 OK` response means the setup is correct.

## Environment Variables & Secrets

`SHOPIFY_SHARED_SECRET` is used to verify the HMAC signature on incoming webhooks. You can find it in the Shopify admin under Settings → Notifications → Webhooks, at the bottom of the page.

`SHOPIFY_ACCESS_TOKEN` is the Admin API access token for writing metafields. It is created when you install a custom app with `write_orders` scope.

`SHOPIFY_SHOP_DOMAIN` is your store's `.myshopify.com` domain, visible in the Shopify admin URL.

Never commit these values to version control. In production, store them in Cloudflare's encrypted secret store (which `wrangler secret put` does automatically) or an external vault.

## How It Works

### HMAC Verification

Shopify signs every webhook with your Shared Secret using HMAC-SHA256 and sends the Base64-encoded signature in the `X-Shopify-Hmac-Sha256` header. The critical detail is that the signature is computed over the raw request body, not the parsed JSON. Even a single byte of difference — whitespace, key order — will invalidate it. That is why the handler calls `await request.text()` before attempting `JSON.parse()`. The comparison uses `crypto.timingSafeEqual` to prevent timing attacks, since a naive `===` comparison would leak information about the expected signature through response-time variations.

### Sanitization

The handler performs a deep copy of the order payload and then redacts or removes sensitive fields. The full list and reasoning are in the next section.

### Relaying Onward

The cleaned payload is written back to the Shopify store as an order metafield using the `metafieldsSet` GraphQL mutation. This simulates sending data to a third-party system. The `ctx.waitUntil()` function is used to perform the Admin API call after returning a `200 OK` to Shopify. Shopify expects a response within 5 seconds and will retry the webhook up to 19 times if it does not receive one. Decoupling the response from the downstream call prevents unnecessary retries.

## Data Sanitization Rationale

The following fields are redacted or removed before the payload is relayed. The guiding principle is data minimization: relay only what the destination actually needs, and never expose PII unnecessarily.

The `email` field is redacted to `[REDACTED]` because it is direct PII and a unique identifier that can be traced to an individual. The `phone` field is redacted for the same reason, and because it is often used for SMS-based attacks if leaked. The `note` field is redacted because it is a free-text field that frequently contains delivery instructions, gate codes, or other personal details. The `client_details` object is removed entirely because it contains IP address and user-agent, both of which are personal data under UK GDPR. The `shipping_address` and `billing_address` objects are removed entirely because full postal addresses are PII, and if the destination only needs order totals, they are unnecessary. The nested `customer` object is removed entirely because it duplicates PII such as name and email, and may include marketing consent flags.

The following fields are deliberately kept. The `id`, `order_number`, and `created_at` fields are needed to correlate the record with the source system. The `line_items` array contains product SKUs and quantities, with no PII. The `total_price` and `currency` fields are financial data, not personal. The `financial_status` and `fulfillment_status` fields represent operational state.

This matters legally. Under the UK GDPR and the Data Protection Act 2018, personal data must be adequate, relevant, and limited to what is necessary. Stripping PII before relaying to an unknown third party is both a technical best practice and a compliance requirement.

## What I'd Do Differently in Production

This implementation is a proof-of-concept. It works end-to-end, but several deliberate simplifications would need to be addressed before it could handle real customer traffic. Below is an honest account of what I would change and why.

### Webhooks are not a reliable delivery mechanism

The single most important architectural change is recognizing that webhooks are fundamentally unreliable as a primary data channel. Shopify operates on an "at-least-once" delivery model, not "exactly-once" . This means the same webhook may arrive multiple times, and conversely, some webhooks may never arrive at all if your endpoint is persistently unavailable.

Shopify's retry behavior makes this concrete. If your endpoint does not return a 2xx response within 5 seconds, Shopify considers the delivery failed and retries up to 8 times over the next 4 hours . If all retries fail, the webhook subscription is removed entirely, and you stop receiving notifications for that topic . There is no built-in mechanism to recover events that were dropped during an outage.

This has a critical implication: **you cannot rely on webhooks as the sole source of truth**. If your service goes down for any reason — a Cloudflare outage, a bad deploy, a traffic spike during Black Friday — you will lose webhooks. When your service comes back up, there is no automatic replay. The events are simply gone.

The practical solution is to add a **reconciliation job** that runs on a schedule (for example, every 15 minutes via Cloudflare Cron Triggers). This job queries the Shopify Admin API for orders created or updated since the last successful reconciliation, using a stored cursor or timestamp. Any orders that were missed due to webhook failures are then processed. This is the standard pattern for building reliable systems on top of unreliable webhook delivery .

### Queue-based delivery instead of waitUntil

Right now, the Admin API call runs inside `ctx.waitUntil()`. If the call fails — for example, Shopify returns a 5xx, or the network times out — the error is logged but the payload is lost. There is no retry. In production, I would place a queue (Cloudflare Queues, or SQS if on AWS) between the webhook handler and the downstream call.

The Worker would enqueue the sanitized payload and return `200 OK` immediately. A separate consumer would pull from the queue, call the Admin API (or the real third-party service), and retry with exponential backoff on failure. After a configurable number of attempts, failed messages would go to a dead-letter queue for manual inspection. This decouples ingestion from delivery and makes the system resilient to downstream outages.

The queue also provides **backpressure**. During a recovery surge — when Shopify flushes a backlog of webhooks after an outage — your endpoint may receive 3x the normal volume or more . A queue absorbs this spike: the ingestion tier acknowledges quickly, and the consumer processes at a sustainable rate. Without a queue, the spike would overwhelm your handler, causing timeouts and more retries.

### Idempotency and duplicate delivery

Shopify may deliver the same webhook more than once. The current implementation does not track which webhooks have already been processed. In production, I would read the `X-Shopify-Webhook-Id` header, store processed IDs in Cloudflare KV or D1 with a TTL of a few days, and skip any webhook whose ID has already been seen . This is the single most important change for correctness.

### Secrets management

For this exercise, secrets are set via `wrangler secret put` and stored in Cloudflare's encrypted secret store. That is acceptable for a single-environment deployment, but it does not scale to staging and production with separate credentials, and it does not support automated rotation. In production, I would use Cloudflare Secrets Store (which supports centralised management and rotation) or an external vault such as HashiCorp Vault or AWS Secrets Manager. Secrets would be injected into the Worker at deploy time via a CI/CD pipeline, never typed manually into a terminal.

### Environment separation

The current setup has a single Worker and a single set of secrets. There is no way to test a change without affecting production traffic. In production, I would use Wrangler environments (`[env.staging]`, `[env.production]`) with separate secrets, separate Shopify stores (or at least separate webhook endpoints), and separate Cloudflare routes. Deployments would go to staging first, be verified against a test order, and then be promoted to production.

### Structured logging and observability

`console.log` output is fine for local debugging, but it is not queryable and does not carry enough context to trace a single webhook through the system. In production, I would emit structured JSON logs with a correlation ID (derived from `X-Shopify-Webhook-Id`), the shop domain, the order GID, and the outcome of each step. These would be shipped to a log aggregator (Datadog, Logpush, or similar). I would also emit metrics — webhook volume, HMAC failure rate, Admin API latency, queue depth — and set up alerts for HMAC failures (possible attack or misconfiguration) and Admin API error spikes (possible token expiry or scope issue).

### Sanitization rules as configuration

The list of fields to redact is currently hardcoded in `sanitizeOrder`. If the client later decides that, say, `line_items[].price` should also be redacted, that requires a code change and a deploy. In production, I would move the rules into a configuration file (JSON or YAML) that can be updated independently, and I would version it so that changes are auditable. I would also add a "dry run" mode that logs what would be redacted without actually modifying the payload, useful for validating rule changes before they go live.

### Input validation and payload shape

The current code trusts that the webhook payload contains the fields it expects. If Shopify changes its schema, or if a malicious actor somehow bypasses HMAC verification, the code could throw or behave unexpectedly. In production, I would validate the payload against a schema (using Zod, Valibot, or a JSON Schema validator) before processing it. This would catch schema drift early and produce clearer error messages.

### Testing

There are no automated tests. In production, I would write unit tests for `verifyWebhook` (valid signature, invalid signature, missing header, wrong secret, tampered body) and for `sanitizeOrder` (each redacted field, each removed object, edge cases like missing fields). I would use real Shopify payload fixtures captured from a development store, so the tests reflect actual data shapes. I would also add an integration test that sends a signed request to a locally running Worker and asserts that the metafield is written.

### Metafield size limit

Shopify caps `json` metafields at 100 KB. The current code checks for this and throws if the limit is exceeded, but it does not handle the case gracefully. In production, if a payload exceeded the limit, I would store the full sanitized payload in R2 (or S3) and write only a reference (the object key) into the metafield. The downstream consumer would then fetch the full payload from object storage. This keeps the metafield small and predictable.

### Rate limiting and abuse protection

The Worker is publicly accessible. While HMAC verification prevents forged webhooks, an attacker could still flood the endpoint with invalid requests to consume Worker invocations and drive up costs. In production, I would add Cloudflare rate limiting rules in front of the Worker, and I would validate the `X-Shopify-Shop-Domain` header against an allowlist so that a leaked secret from one store cannot be used to send webhooks to another store's endpoint.

### Compliance and data retention

The sanitized payload is stored in a metafield indefinitely. Under UK GDPR, personal data should not be retained longer than necessary, and data subjects have the right to erasure. Even though the payload is sanitized, it may still contain data that could be linked to an individual (for example, an order ID combined with a timestamp). In production, I would define a retention policy — for example, delete the metafield after 90 days — and implement it as a scheduled Worker or a cron job. I would also document in the privacy policy what data is relayed and why.

## Testing Locally

Start the dev server with `npx wrangler dev`. The Worker will be available at `http://localhost:8787`.

Because HMAC verification is enforced, you cannot just `curl` an arbitrary JSON body. You need to compute a valid signature. Here is a Node.js snippet to generate one:

```javascript
const crypto = require("crypto");

const secret = "your_shared_secret_here";
const payload = JSON.stringify({
  id: 1234567890,
  email: "test@example.com",
  phone: "+441234567890",
  total_price: "99.99",
  currency: "GBP",
  line_items: [{ sku: "MED-001", quantity: 1 }],
});

const hmac = crypto
  .createHmac("sha256", secret)
  .update(payload, "utf8")
  .digest("base64");

console.log("HMAC:", hmac);
console.log("Payload:", payload);
```

Then send it with `curl`:

```bash
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Hmac-Sha256: <hmac_from_above>" \
  -d '<payload_from_above>'
```

A `200 OK` response means verification passed. Any modification to the payload after signing will produce a `401 Unauthorized`.

## Project Structure

The project has a `src/index.js` file for the Worker entry point, a `wrangler.toml` for Cloudflare configuration, a `.dev.vars` file for local secrets (gitignored), a `.gitignore`, a `package.json`, and this `README.md`.

## Known Limitations

There is no idempotency, so duplicate webhook deliveries will result in duplicate metafield writes. There is no retry logic, so if the Admin API call fails, the payload is lost and the `waitUntil` promise rejects silently. Shopify metafields are capped at 100 KB for the `json` type, so very large orders could exceed this limit. There is no pagination handling, though this is not an issue here because the webhook payload for an order is bounded — it would matter for bulk operations. There is a single environment with no staging or production separation. In production I would use Wrangler environments with `[env.staging]` and `[env.production]` sections. Secrets management is CLI-based and not suitable for CI/CD without additional tooling. There is no reconciliation job to recover events lost during webhook delivery failures.

## License

This code is provided as-is for evaluation purposes. No warranty is expressed or implied.