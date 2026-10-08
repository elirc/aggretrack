import type { Job } from "pg-boss";
import { getBoss } from "./boss";

const WORK_OPTIONS = { batchSize: 1, pollingIntervalSeconds: 2 };

async function main(): Promise<void> {
  const boss = await getBoss();

  // WAVE1: replace with real handlers from worker/jobs/* (P1-D).

  // --- document.generate ------------------------------------------------
  await boss.work("document.generate", WORK_OPTIONS, async (jobs: Job<object>[]) => {
    console.log(`[worker] document.generate placeholder (${jobs.length} job[s])`);
  });

  // --- sms.send ----------------------------------------------------------
  await boss.work("sms.send", WORK_OPTIONS, async (jobs: Job<object>[]) => {
    console.log(`[worker] sms.send placeholder (${jobs.length} job[s])`);
  });

  // --- email.send ---------------------------------------------------------
  await boss.work("email.send", WORK_OPTIONS, async (jobs: Job<object>[]) => {
    console.log(`[worker] email.send placeholder (${jobs.length} job[s])`);
  });

  // --- alerts.scan ---------------------------------------------------------
  await boss.work("alerts.scan", WORK_OPTIONS, async (jobs: Job<object>[]) => {
    console.log(`[worker] alerts.scan placeholder (${jobs.length} job[s])`);
  });

  // --- billing.sweep --------------------------------------------------------
  await boss.work("billing.sweep", WORK_OPTIONS, async (jobs: Job<object>[]) => {
    console.log(`[worker] billing.sweep placeholder (${jobs.length} job[s])`);
  });

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
