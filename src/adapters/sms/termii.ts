import type { SmsAdapter } from "./types";

interface TermiiSendResponse {
  code?: string;
  message_id?: string;
  message?: string;
}

/**
 * Termii SMS driver. See docs/plan/INTEGRATIONS.md §2.
 * Auth is the api_key field in the JSON body (not a header).
 * channel "dnd" = transactional, delivers despite DND blocks.
 */
export function createTermiiSms(): SmsAdapter {
  const apiKey = process.env.TERMII_API_KEY;
  const senderId = process.env.TERMII_SENDER_ID;
  const baseUrl = process.env.TERMII_BASE_URL ?? "https://api.ng.termii.com";
  if (!apiKey || !senderId) {
    throw new Error("SMS_DRIVER=termii requires TERMII_API_KEY and TERMII_SENDER_ID");
  }
  return {
    async send(to, body) {
      const res = await fetch(`${baseUrl}/api/sms/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          to: to.replace(/^\+/, ""),
          from: senderId,
          sms: body,
          type: "plain",
          channel: "dnd",
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Termii send failed: ${res.status} ${text}`);
      }
      const data = (await res.json()) as TermiiSendResponse;
      return { id: data.message_id ?? "termii-unknown" };
    },
  };
}
