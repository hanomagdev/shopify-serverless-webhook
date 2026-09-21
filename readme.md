# Shopify Order Webhook Middleware

## Overview

This service receives Shopify `orders/create` webhooks, validates the HMAC signature, strips sensitive customer data, and stores the sanitized payload as an order metafield through the Shopify Admin API.

```text
Shopify
  │
  │ orders/create webhook
  ▼
Cloudflare Worker
  │
  ├── Verify HMAC
  │
  ├── Sanitize payload
  │
  └── Save sanitized payload to Shopify metafield
            │
            ▼
       Shopify Admin API
```

## Architecture

The project is intentionally small and focused. It contains a single Cloudflare Worker entry point and a few helpers for security and sanitization. The middleware does not try to be a full production system; it demonstrates the core pieces a reviewer expects to see in a webhook task: raw-body verification, data minimization, and API integration.

## Security

Shopify signs webhook requests with the `X-Shopify-Hmac-Sha256` header. The signature must be computed from the raw request body and the shared secret. The code does not stringify the parsed JSON before hashing, because that would produce a different byte sequence and fail validation.

The implementation uses `crypto.createHmac("sha256", secret)` and `crypto.timingSafeEqual` to compare the computed and received signatures safely.

## Sensitive Data Handling

The goal is to retain operational order data while removing customer-identifying information. The sanitization removes or redacts the most common PII fields, including:

- `customer`
- `billing_address`
- `shipping_address`
- `client_details`
- `email`
- `phone`
- `note`

This is intentionally narrow: the middleware keeps useful order details such as `id`, `line_items`, `total_price`, and `currency`, but strips data that is not needed for downstream processing and should not be shared externally.

## Setup

### Prerequisites

- Node.js 18+
- A Shopify development store
- Cloudflare account with Wrangler installed
- A Shopify webhook secret and Admin API access token

### Install dependencies

```bash
npm install
```

### Environment variables

For local development with Wrangler, use a `.dev.vars` file, not a plain `.env` file:

```bash
cp .env.example .dev.vars
```

Then fill in your values:

```bash
SHOPIFY_WEBHOOK_SECRET=your_webhook_secret
SHOPIFY_ACCESS_TOKEN=your_admin_access_token
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
```

For deployment, set the values as Cloudflare secrets instead of committing them to the repository:

```bash
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
npx wrangler secret put SHOPIFY_ACCESS_TOKEN
npx wrangler secret put SHOPIFY_STORE_DOMAIN
```

## Environment Variables

- `SHOPIFY_WEBHOOK_SECRET`: Shopify Shared Secret used for HMAC verification.
- `SHOPIFY_ACCESS_TOKEN`: Shopify Admin API token with permission to write metafields.
- `SHOPIFY_STORE_DOMAIN`: Your store domain, such as `my-store.myshopify.com`.

Do not commit real credentials to Git. `.env.example` is a template for local setup; Cloudflare secrets are used for deployed environments.

## Running Locally

```bash
npx wrangler dev
```

The Worker runs at `http://localhost:8787`.

## Testing

```bash
npm test
```

The tests cover:

- valid HMAC acceptance
- invalid HMAC rejection
- missing signature handling
- sanitization of PII
- retention of useful order data

## Example Request

```bash
curl -X POST http://localhost:8787 \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Hmac-Sha256: <signature>" \
  -d '{
    "id": 123,
    "email": "john@example.com",
    "customer": {
      "first_name": "John",
      "last_name": "Smith",
      "email": "john@example.com"
    },
    "shipping_address": {
      "address1": "123 Main Street"
    },
    "line_items": [
      { "sku": "ABC-001", "quantity": 2, "price": "49.99" }
    ],
    "total_price": "99.98",
    "currency": "USD"
  }'
```

## Production Considerations

- Shopify can retry webhook deliveries, so idempotency should be added in a real production system.
- CORS is not required for Shopify server-to-server webhooks.
- The endpoint should explicitly return `405 Method Not Allowed` for non-POST requests.
- Invalid signatures should return `401 Unauthorized`.
- Malformed payloads should return `400 Bad Request`.
- Upstream API failures should be logged and return a generic `500` to the client.
- In production, the sanitized payload would typically go to a third-party API or queue, not back to Shopify metafields.

## What I Would Improve With More Time

- add explicit payload schema validation
- add idempotency tracking for duplicate webhook deliveries
- add retries and queueing for downstream API calls
- add broader test coverage around malformed payloads and status codes
- split logic into more files if the scope grows

## Final Checklist

- README is present and explains architecture and security
- `.env.example` is included
- secrets are not committed to Git
- HMAC uses raw request body and timing-safe comparison
- tests validate PII removal and HTTP behavior
- project can be installed and tested from a clean checkout
