import type { ShopifyOrder } from "./types";

export function sanitizeOrder(order: ShopifyOrder): ShopifyOrder {
  const sanitized: ShopifyOrder = JSON.parse(JSON.stringify(order));

  if (sanitized.email) sanitized.email = "[REDACTED]";
  if (sanitized.phone) sanitized.phone = "[REDACTED]";
  if (sanitized.note) sanitized.note = "[REDACTED]";

  delete sanitized.customer;
  delete sanitized.billing_address;
  delete sanitized.shipping_address;
  delete sanitized.client_details;

  return sanitized;
}
