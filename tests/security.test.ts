import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyWebhook } from "../src/security";

describe("verifyWebhook", () => {
  it("accepts a valid Shopify HMAC", () => {
    const secret = "test_secret";
    const payload = JSON.stringify({ id: 12345, email: "test@example.com" });
    const signature = crypto
      .createHmac("sha256", secret)
      .update(payload, "utf8")
      .digest("base64");

    expect(verifyWebhook(payload, signature, secret)).toBe(true);
  });

  it("rejects a mismatched HMAC", () => {
    const secret = "test_secret";
    const payload = JSON.stringify({ id: 12345 });
    const badSignature = crypto
      .createHmac("sha256", "different_secret")
      .update(payload, "utf8")
      .digest("base64");

    expect(verifyWebhook(payload, badSignature, secret)).toBe(false);
  });

  it("rejects missing HMAC headers", () => {
    expect(verifyWebhook("{}", null, "secret")).toBe(false);
  });
});
