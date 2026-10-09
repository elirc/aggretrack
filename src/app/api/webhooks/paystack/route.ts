import { db } from "@/db/client";
import { getPaymentsAdapter } from "@/adapters/payments";
import { applyWebhookEvent } from "@/lib/services/billing";

/**
 * Paystack webhook (INTEGRATIONS §4). Verifies x-paystack-signature (HMAC-SHA512
 * of the RAW body keyed with the secret key) via the payments adapter, then
 * applies the event. Handled AND ignored events answer 200 quickly; a bad
 * signature is 401; an unexpected failure is 500 so Paystack retries (the
 * handler is replay-safe).
 */
export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const event = getPaymentsAdapter().verifyWebhook(rawBody, req.headers.get("x-paystack-signature"));
  if (!event) {
    return Response.json({ ok: false, error: "INVALID_SIGNATURE" }, { status: 401 });
  }
  try {
    const result = await applyWebhookEvent(db, event);
    return Response.json({ ok: true, outcome: result.outcome });
  } catch (err) {
    console.error(`[webhooks/paystack] failed to apply ${event.event}`, err);
    return Response.json({ ok: false, error: "INTERNAL" }, { status: 500 });
  }
}
