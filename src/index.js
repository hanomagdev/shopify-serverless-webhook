import { Buffer } from "node:buffer";
import crypto from "node:crypto";

/**
 * Verifies the HMAC signature of an incoming Shopify webhook.
 * @param {string} rawBody - The raw request body (string).
 * @param {string} hmacHeader - The value of the X-Shopify-Hmac-Sha256 header.
 * @param {string} secret - Your Shopify Shared Secret.
 * @returns {boolean} - true if the signature is valid.
 */
function verifyWebhook(rawBody, hmacHeader, secret) {
  if (!hmacHeader) {
    console.error("verifyWebhook: missing X-Shopify-Hmac-Sha256 header");
    return false;
  }

  if (!secret) {
    console.error("verifyWebhook: SHOPIFY_SHARED_SECRET is not set");
    return false;
  }

  // Compute the expected signature over the raw request body.
  // Shopify signs the raw bytes, not the parsed JSON.
  const computedHmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  console.log("verifyWebhook: computed =", computedHmac);
  console.log("verifyWebhook: received =", hmacHeader);
  console.log("verifyWebhook: secret length =", secret.length);

  try {
    // Both signatures are Base64-encoded strings. Decode them to raw bytes
    // before comparing, otherwise we would be comparing the UTF-8 bytes of
    // the Base64 text rather than the underlying HMAC bytes.
    const computedBuffer = Buffer.from(computedHmac, "base64");
    const receivedBuffer = Buffer.from(hmacHeader, "base64");

    if (computedBuffer.length !== receivedBuffer.length) {
      console.error(
        `verifyWebhook: length mismatch (${computedBuffer.length} vs ${receivedBuffer.length})`
      );
      return false;
    }

    const isValid = crypto.timingSafeEqual(computedBuffer, receivedBuffer);
    console.log("verifyWebhook: valid =", isValid);
    return isValid;
  } catch (e) {
    console.error("verifyWebhook: comparison error:", e.message);
    return false;
  }
}

/**
 * Strips sensitive customer data from the order payload.
 * @param {object} order - The order object from the webhook.
 * @returns {object} - The sanitized object.
 */
function sanitizeOrder(order) {
  // Deep copy so we do not mutate the original payload.
  const sanitized = JSON.parse(JSON.stringify(order));

  // Redact direct personally identifiable information.
  if (sanitized.email) sanitized.email = "[REDACTED]";
  if (sanitized.phone) sanitized.phone = "[REDACTED]";
  if (sanitized.note) sanitized.note = "[REDACTED]";

  // Remove objects that contain PII or metadata about the client.
  delete sanitized.client_details;
  delete sanitized.shipping_address;
  delete sanitized.billing_address;
  delete sanitized.customer;

  return sanitized;
}

/**
 * Saves the cleaned data as a metafield in Shopify via the Admin API.
 * @param {string} orderGid - The order GID (e.g. gid://shopify/Order/123).
 * @param {object} cleanedData - The sanitized order payload.
 * @param {object} env - Cloudflare environment bindings (secrets).
 */
async function saveMetafield(orderGid, cleanedData, env) {
  const shopDomain = env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = env.SHOPIFY_ACCESS_TOKEN;

  if (!shopDomain || !accessToken) {
    throw new Error(
      "Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ACCESS_TOKEN environment variable"
    );
  }

  // Shopify metafields of type "json" are capped at 100 KB.
  const serialized = JSON.stringify(cleanedData);
  if (serialized.length > 100_000) {
    throw new Error(
      `Sanitized payload exceeds metafield size limit (${serialized.length} bytes)`
    );
  }

  const mutation = `
    mutation CreateOrderMetafield($ownerId: ID!, $namespace: String!, $key: String!, $value: String!, $type: String!) {
      metafieldsSet(metafields: [{
        ownerId: $ownerId
        namespace: $namespace
        key: $key
        value: $value
        type: $type
      }]) {
        metafields { id }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    ownerId: orderGid,
    namespace: "my_app",
    key: "sanitized_payload",
    value: serialized,
    type: "json",
  };

  const response = await fetch(
    `https://${shopDomain}/admin/api/2024-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query: mutation, variables }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Admin API HTTP ${response.status}: ${text}`);
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  const userErrors = result.data?.metafieldsSet?.userErrors;
  if (userErrors && userErrors.length > 0) {
    throw new Error(`Metafield user errors: ${JSON.stringify(userErrors)}`);
  }

  console.log("saveMetafield: metafield written successfully");
  return result;
}

export default {
  async fetch(request, env, ctx) {
    // This endpoint only accepts POST requests from Shopify.
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      // 1. Read the raw request body. This MUST happen before any other
      //    read of the request body, because Shopify signs the raw bytes.
      const rawBody = await request.text();
      const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");

      // 2. Verify the HMAC signature to confirm the request came from Shopify.
      if (!verifyWebhook(rawBody, hmacHeader, env.SHOPIFY_SHARED_SECRET)) {
        console.error("Invalid webhook signature");
        return new Response("Unauthorized", { status: 401 });
      }

      // 3. Parse the payload.
      const orderPayload = JSON.parse(rawBody);

      // Prefer the GID that Shopify already provides. Fall back to building
      // it manually from the numeric id if the GID is absent.
      const orderGid =
        orderPayload.admin_graphql_api_id ||
        `gid://shopify/Order/${orderPayload.id}`;

      console.log(`Received valid webhook for order ${orderGid}`);

      // 4. Sanitize sensitive data.
      const cleanedPayload = sanitizeOrder(orderPayload);

      // 5. Relay the data onward. We respond to Shopify immediately and let
      //    the Admin API call run in the background. Errors are logged so
      //    they are visible in `wrangler tail`.
      ctx.waitUntil(
        saveMetafield(orderGid, cleanedPayload, env).catch((err) => {
          console.error("saveMetafield failed:", err.message, err.stack);
        })
      );

      // Shopify expects a fast 200 OK response.
      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Error processing webhook:", error.message, error.stack);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};