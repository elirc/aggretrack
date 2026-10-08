/**
 * sms.send handler → SMS adapter (mock by default, Termii when SMS_DRIVER=termii).
 * Failures are logged and rethrown so pg-boss retries per the send-time options.
 */
import type { Job } from "pg-boss";

import { getSmsAdapter } from "../../src/adapters/sms";
import type { SmsSendJob } from "../../src/lib/jobs";

export async function sendSms(data: SmsSendJob): Promise<{ id: string } | null> {
  if (!data?.to || !data?.body) {
    console.warn("[sms] invalid sms.send payload; dropping", data);
    return null; // malformed payloads never succeed — don't retry
  }
  return getSmsAdapter().send(data.to, data.body);
}

export async function handleSmsSend(jobs: Job<SmsSendJob>[]): Promise<void> {
  for (const job of jobs) {
    try {
      const res = await sendSms(job.data);
      if (res) console.log(`[sms] sent job ${job.id} (org ${job.data.orgId}) -> ${res.id}`);
    } catch (err) {
      console.error(
        `[sms] send failed job ${job.id} (org ${job.data?.orgId}, retry ${job.retryCount ?? 0})`,
        err,
      );
      throw err;
    }
  }
}
