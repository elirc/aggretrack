import { getBoss } from "./boss";
import { QUEUES } from "../src/lib/jobs";
import { handleAlertsScan } from "./jobs/alerts";
import { handleBillingSweep } from "./jobs/billing";
import { handleDocumentGenerate } from "./jobs/documents";
import { handleEmailSend } from "./jobs/email";
import { handleSmsSend } from "./jobs/sms";

const WORK_OPTIONS = { batchSize: 1, pollingIntervalSeconds: 2 };

async function main(): Promise<void> {
  const boss = await getBoss();

  // --- document.generate ------------------------------------------------
  await boss.work(QUEUES.DOCUMENT_GENERATE, WORK_OPTIONS, handleDocumentGenerate);

  // --- sms.send ----------------------------------------------------------
  await boss.work(QUEUES.SMS_SEND, WORK_OPTIONS, handleSmsSend);

  // --- email.send ---------------------------------------------------------
  await boss.work(QUEUES.EMAIL_SEND, WORK_OPTIONS, handleEmailSend);

  // --- alerts.scan ---------------------------------------------------------
  await boss.work(QUEUES.ALERTS_SCAN, WORK_OPTIONS, handleAlertsScan);

  // --- billing.sweep --------------------------------------------------------
  await boss.work(QUEUES.BILLING_SWEEP, WORK_OPTIONS, handleBillingSweep);

  await boss.schedule("alerts.scan", "*/15 * * * *", {}, { tz: "Africa/Lagos" });
  await boss.schedule("billing.sweep", "0 2 * * *", {}, { tz: "Africa/Lagos" });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] received ${signal}, stopping`);
    try {
      await boss.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log("[worker] started; queues registered");
}

main().catch((err) => {
  console.error("[worker] fatal startup error", err);
  process.exit(1);
});
