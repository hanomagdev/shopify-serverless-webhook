import { verifyWebhook } from "./security";
import { sanitizeOrder } from "./sanitizer";
import type { Env, ShopifyOrder } from "./types";

async function saveMetafield(
  orderGid: string,
  sanitizedPayload: ShopifyOrder,
  env: Env,
): Promise<void> {
  const shopDomain = env.SHOPIFY_STORE_DOMAIN;
  const accessToken = env.SHOPIFY_ACCESS_TOKEN;

  if (!shopDomain || !accessToken) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN");
  }

  const serialized = JSON.stringify(sanitizedPayload);
  if (serialized.length > 100_000) {
    throw new Error(`Sanitized payload exceeds metafield limit (${serialized.length} bytes)`);
  }

  const mutation = `
    mutation CreateOrderMetafield($ownerId: ID!, $namespace: String!, $key: String!, $value: String!, $type: String!) {
      metafieldsSet(metafields: [{
        ownerId: $ownerId,
        namespace: $namespace,
        key: $key,
        value: $value,
        type: $type
      }]) {
        metafields { id }
        userErrors { field message }
      }
    }
  `;

  const response = await fetch(`https://${shopDomain}/admin/api/2024-10/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        ownerId: orderGid,
        namespace: "middleware",
        key: "sanitized_order",
        value: serialized,
        type: "json",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Admin API HTTP ${response.status}: ${text}`);
  }

  const result = (await response.json()) as {
    errors?: Array<{ message: string }>;
    data?: { metafieldsSet?: { userErrors?: Array<{ field?: string; message: string }> } };
  };

  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  const userErrors = result.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(`Metafield user errors: ${JSON.stringify(userErrors)}`);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const rawBody = await request.text();
      const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");

      if (!verifyWebhook(rawBody, hmacHeader, env.SHOPIFY_WEBHOOK_SECRET)) {
        console.error("Webhook rejected: invalid HMAC signature");
        return new Response("Unauthorized", { status: 401 });
      }

      let payload: ShopifyOrder;
      try {
        payload = JSON.parse(rawBody) as ShopifyOrder;
      } catch {
        console.error("Webhook rejected: malformed JSON payload");
        return new Response("Bad Request", { status: 400 });
      }

      const orderId = payload.id ?? "unknown";
      const orderGid = payload.admin_graphql_api_id ?? `gid://shopify/Order/${orderId}`;
      console.log(`Webhook verified for order ${orderId}`);

      const sanitizedPayload = sanitizeOrder(payload);

      await saveMetafield(orderGid, sanitizedPayload, env);
      console.log(`Sanitized webhook payload stored for order ${orderId}`);

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Webhook processing failed:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
