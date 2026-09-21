export type ShopifyOrder = {
  id?: number | string;
  admin_graphql_api_id?: string;
  email?: string;
  phone?: string;
  note?: string;
  customer?: Record<string, unknown>;
  billing_address?: Record<string, unknown>;
  shipping_address?: Record<string, unknown>;
  client_details?: Record<string, unknown>;
  line_items?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

export type Env = {
  SHOPIFY_WEBHOOK_SECRET?: string;
  SHOPIFY_ACCESS_TOKEN?: string;
  SHOPIFY_STORE_DOMAIN?: string;
};
