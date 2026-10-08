/**
 * email.send handler → email adapter (mock by default, Resend when EMAIL_DRIVER=resend).
 * Failures are logged and rethrown so pg-boss retries per the send-time options.
 */
import type { Job } from "pg-boss";

import { getEmailAdapter } from "../../src/adapters/email";
import type { EmailSendJob } from "../../src/lib/jobs";

export async function sendEmail(data: EmailSendJob): Promise<{ id: string } | null> {
  if (!data?.to || !data?.subject || !data?.html) {
    console.warn("[email] invalid email.send payload; dropping", data);
    return null;
  }
  return getEmailAdapter().send({ to: data.to, subject: data.subject, html: data.html });
}

export async function handleEmailSend(jobs: Job<EmailSendJob>[]): Promise<void> {
  for (const job of jobs) {
    try {
      const res = await sendEmail(job.data);
      if (res) console.log(`[email] sent job ${job.id} (org ${job.data.orgId}) -> ${res.id}`);
    } catch (err) {
      console.error(
        `[email] send failed job ${job.id} (org ${job.data?.orgId}, retry ${job.retryCount ?? 0})`,
        err,
      );
      throw err;
    }
  }
}
