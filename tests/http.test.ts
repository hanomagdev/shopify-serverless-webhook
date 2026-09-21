import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

describe("worker HTTP behavior", () => {
  it("returns 405 for non-POST requests", async () => {
    const response = await worker.fetch(
      new Request("https://example.com", { method: "GET" }),
      {
        SHOPIFY_WEBHOOK_SECRET: "secret",
        SHOPIFY_ACCESS_TOKEN: "token",
        SHOPIFY_STORE_DOMAIN: "example.myshopify.com",
      },
    );

    expect(response.status).toBe(405);
  });

  it("returns 401 for an invalid signature", async () => {
    const response = await worker.fetch(
      new Request("https://example.com", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Hmac-Sha256": "invalid-signature",
        },
        body: JSON.stringify({ id: 123 }),
      }),
      {
        SHOPIFY_WEBHOOK_SECRET: "secret",
        SHOPIFY_ACCESS_TOKEN: "token",
        SHOPIFY_STORE_DOMAIN: "example.myshopify.com",
      },
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 for malformed JSON while preserving the HMAC check", async () => {
    const secret = "secret";
    const rawBody = '{"id": 123';
    const signature = crypto
      .createHmac("sha256", secret)
      .update(rawBody, "utf8")
      .digest("base64");

    const response = await worker.fetch(
      new Request("https://example.com", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Hmac-Sha256": signature,
        },
        body: rawBody,
      }),
      {
        SHOPIFY_WEBHOOK_SECRET: secret,
        SHOPIFY_ACCESS_TOKEN: "token",
        SHOPIFY_STORE_DOMAIN: "example.myshopify.com",
      },
    );

    expect(response.status).toBe(400);
  });
});
