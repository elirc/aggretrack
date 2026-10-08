import crypto from "node:crypto";
import type { PaymentsAdapter, PaystackEvent } from "./types";

const BASE_URL = "https://api.paystack.co";

interface PaystackEnvelope<T> {
  status: boolean;
  message?: string;
  data?: T;
}

/**
 * Paystack driver. See docs/plan/INTEGRATIONS.md §4.
 * All amounts are integer kobo. Webhook signature is hex HMAC-SHA512 of the raw
 * body keyed with the SECRET key (there is no separate webhook secret).
 */
export function createPaystackPayments(): PaymentsAdapter {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("PAYMENTS_DRIVER=paystack requires PAYSTACK_SECRET_KEY");
  }

  async function call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Paystack ${path} failed: ${res.status} ${text}`);
    }
    const parsed = JSON.parse(text) as PaystackEnvelope<T>;
    if (!parsed.status || parsed.data === undefined) {
      throw new Error(`Paystack ${path} rejected: ${parsed.message ?? text}`);
    }
    return parsed.data;
  }

  return {
    async createPlan({ name, amountKobo, interval }) {
      const data = await call<{ plan_code?: string }>("/plan", {
        name,
        interval,
        amount: amountKobo,
        currency: "NGN",
      });
      if (typeof data.plan_code !== "string") {
        throw new Error("Paystack /plan response missing plan_code");
      }
      return { planCode: data.plan_code };
    },

    async initializeSubscription({ email, planCode, amountKobo, metadata }) {
      const data = await call<{ authorization_url?: string; reference?: string }>(
        "/transaction/initialize",
        {
          email,
          amount: amountKobo,
          plan: planCode,
          ...(metadata ? { metadata } : {}),
        },
      );
      if (typeof data.authorization_url !== "string" || typeof data.reference !== "string") {
        throw new Error("Paystack /transaction/initialize response missing fields");
      }
      return { checkoutUrl: data.authorization_url, reference: data.reference };
    },

    verifyWebhook(rawBody, signature) {
      if (!signature) return null;
      const expected = crypto.createHmac("sha512", secretKey).update(rawBody).digest("hex");
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(expBuf, sigBuf)) {
        return null;
      }
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
          return { event: obj.event, data } satisfies PaystackEvent;
        }
        return null;
      } catch {
        return null;
      }
    },

    async cancelSubscription({ subscriptionCode, emailToken }) {
      await call<unknown>("/subscription/disable", {
        code: subscriptionCode,
        token: emailToken,
      });
    },
  };
}
