import { describe, expect, it } from "vitest";

import { sanitizeOrder } from "../src/sanitizer";

describe("sanitizeOrder", () => {
  it("removes customer information while preserving useful order data", () => {
    const payload = {
      id: 123,
      email: "john@example.com",
      customer: {
        first_name: "John",
        last_name: "Smith",
        email: "john@example.com",
      },
      billing_address: { address1: "123 Main Street" },
      shipping_address: { address1: "456 Oak Avenue" },
      client_details: { ip: "127.0.0.1" },
      line_items: [{ sku: "ABC-1", quantity: 2 }],
      total_price: "99.99",
      currency: "USD",
    };

    const result = sanitizeOrder(payload);

    expect(result.id).toBe(123);
    expect(result.email).toBe("[REDACTED]");
    expect(result.customer).toBeUndefined();
    expect(result.billing_address).toBeUndefined();
    expect(result.shipping_address).toBeUndefined();
    expect(result.client_details).toBeUndefined();
    expect(result.line_items).toEqual([{ sku: "ABC-1", quantity: 2 }]);
    expect(result.total_price).toBe("99.99");
  });
});
