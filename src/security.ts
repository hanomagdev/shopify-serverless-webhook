import { Buffer } from "node:buffer";
import crypto from "node:crypto";

export function verifyWebhook(
  rawBody: string,
  hmacHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!hmacHeader) {
    console.error("verifyWebhook: missing X-Shopify-Hmac-Sha256 header");
    return false;
  }

  if (!secret) {
    console.error("verifyWebhook: SHOPIFY_WEBHOOK_SECRET is not set");
    return false;
  }

  const computedHmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  console.log("Webhook HMAC validated successfully");

  try {
    const computedBuffer = Buffer.from(computedHmac, "base64");
    const receivedBuffer = Buffer.from(hmacHeader, "base64");

    if (computedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(computedBuffer, receivedBuffer);
  } catch {
    return false;
  }
}
