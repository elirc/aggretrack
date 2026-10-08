import { Resend } from "resend";
import type { EmailAdapter } from "./types";

/** Resend driver. See docs/plan/INTEGRATIONS.md §3. */
export function createResendEmail(): EmailAdapter {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error("EMAIL_DRIVER=resend requires RESEND_API_KEY and EMAIL_FROM");
  }
  const resend = new Resend(apiKey);
  return {
    async send({ to, subject, html, text }) {
      const { data, error } = await resend.emails.send({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(text ? { text } : {}),
      });
      if (error) {
        throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
      }
      return { id: data?.id ?? "resend-unknown" };
    },
  };
}
