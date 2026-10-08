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
      return { checkoutUrl: `/mock-checkout?ref=${reference}`, reference };
    },
    verifyWebhook(rawBody, signature) {
      // Mock driver: accept the fixed test signature, or anything outside production.
      if (signature !== "mock-signature" && process.env.APP_ENV === "production") {
        return null;
      }
      return parseEvent(rawBody);
    },
    async cancelSubscription({ subscriptionCode }) {
      console.log(`[PAYMENTS:mock] cancelSubscription ${subscriptionCode}`);
    },
  };
}
