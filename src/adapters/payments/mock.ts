import type { PaymentsAdapter, PaystackEvent } from "./types";

function parseEvent(rawBody: string): PaystackEvent | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (
        typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { event?: unknown }).event === "string"
    ) {
      const obj = parsed as { event: string; data?: unknown };
      const data =
        typeof obj.data === "object" && obj.data !== null
          ? (obj.data as Record<string, unknown>)
          : {};
      return { event: obj.event, data };
    }
    return null;
  } catch {
    return null;
  }
}

/** Header value the mock driver accepts as a valid x-paystack-signature. */
export const MOCK_SIGNATURE = "mock-signature";

export function createMockPayments(): PaymentsAdapter {
  return {
    async createPlan({ name }) {
      const slug = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
      console.log(`[PAYMENTS:mock] createPlan ${name}`);
      return { planCode: `PLN_MOCK_${slug}` };
    },
    async initializeSubscription({ email, planCode }) {
      const reference = `MOCK_${crypto.randomUUID()}`;
      console.log(`[PAYMENTS:mock] initializeSubscription email=${email} plan=${planCode} ref=${reference}`);
      const qs = new URLSearchParams({ ref: reference, plan: planCode });
      return { checkoutUrl: `/settings/billing/mock-checkout?${qs.toString()}`, reference };
    },
    verifyWebhook(rawBody, signature) {
      // Mock driver: only the fixed signature verifies (the demo mock-checkout
      // page sends it). Anything else is rejected, like a bad HMAC would be.
      if (signature !== MOCK_SIGNATURE) return null;
      return parseEvent(rawBody);
    },
    async cancelSubscription({ subscriptionCode }) {
      console.log(`[PAYMENTS:mock] cancelSubscription ${subscriptionCode}`);
    },
  };
}
